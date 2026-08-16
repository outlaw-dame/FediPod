// ai.mjs — thin wrapper around the OpenAI SDK for the Ailo/FediPod extension
// endpoints (/api/v1/ailo/ai/*, see mastoapi.mjs). Nothing here sits on the
// standard ActivityPub/Mastodon wire path.
//
// Every function here takes its API key explicitly rather than reading
// process.env itself. Two reasons: (1) a key saved through Ailo's provider
// UI (lib/store.mjs's provider-credentials.json) has to take effect on the
// very next call, not after a restart — a module-level client cached against
// whatever key was live at startup would silently keep using the old one;
// (2) mastoapi.mjs is the one place that already knows how to resolve
// "local saved key, else AP_OPENAI_API_KEY, else unconfigured" (see
// credentialFor() there), so this module stays a pure function of its inputs
// and doesn't need its own copy of that resolution logic.

import OpenAI from 'openai';
import { matchVectors } from './vector-match.mjs';
import { DRAFT_CUSTOM_FEED_TOOL } from './assistant-tools.mjs';

// One client per apiKey, not one client total — a test call with an unsaved
// key (POST .../test with a body api_key) must not leave the *live* client
// pointed at a key that was only ever being tried out.
const clients = new Map();
function openai(apiKey) {
  if (!apiKey) throw new Error('an OpenAI API key is required');
  let client = clients.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

// Exported so mastoapi.mjs's /api/v1/ailo/ai/status can report the model in
// use without keeping its own copy of the default/env-var name to drift out
// of sync with this one.
export function chatModel() { return process.env.AP_OPENAI_MODEL || 'gpt-4o-mini'; }
function embedModel() { return process.env.AP_OPENAI_EMBED_MODEL || 'text-embedding-3-small'; }

async function chatJson({ apiKey, system, prompt }) {
  const res = await openai(apiKey).chat.completions.create({
    model: chatModel(),
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });
  const text = res.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no content');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('OpenAI returned invalid JSON');
  }
}

const uniqueStrings = (value, max = 30) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, max);

export function cleanCustomFeedDraft(raw, fallbackName = 'New feed') {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    name: String(data.name || fallbackName).trim().slice(0, 80) || 'New feed',
    description: String(data.description || '').trim().slice(0, 500),
    accounts: uniqueStrings(data.accounts), hashtags: uniqueStrings(data.hashtags).map((tag) => tag.replace(/^#/, '')),
    semantic_keywords: uniqueStrings(data.semantic_keywords), exclude_words: uniqueStrings(data.exclude_words),
    exclude_accounts: uniqueStrings(data.exclude_accounts), avatar_url: null, banner_url: null,
  };
}

export async function draftCustomFeed({ apiKey, prompt }) {
  const request = String(prompt || '').trim().slice(0, 4000);
  if (!request) throw new Error('a feed description is required');
  const data = await chatJson({ apiKey,
    system: 'Turn a user request into a concise custom social-feed definition. Return JSON with name, description, accounts, hashtags, semantic_keywords, exclude_words, and exclude_accounts. Never invent an account handle: accounts may contain only handles explicitly present in the request. Use hashtags and semantic phrases for themes. Include at least one inclusive rule. No commentary.',
    prompt: request });
  return cleanCustomFeedDraft(data, request.slice(0, 80));
}

const MAX_ASSISTANT_MESSAGES = 20;
const MAX_ASSISTANT_MESSAGE_LENGTH = 4000;

/**
 * Open-ended, multi-turn chat for the compose assistant panel — plain text,
 * not chatJson's structured-output mode. `messages` is the running
 * conversation (oldest first); only the last MAX_ASSISTANT_MESSAGES survive,
 * so a long-running chat degrades to "recent context" rather than blowing
 * past the model's window or growing the request without bound.
 *
 * The model may call draft_custom_feed instead of (or alongside) replying in
 * text — when it does, this actually runs draftCustomFeed and returns the
 * result as `action`, so "make me a feed about hiking" produces a real,
 * savable draft rather than the assistant just describing one in prose.
 */
export async function assistantReply({ apiKey, system, messages }) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_ASSISTANT_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_ASSISTANT_MESSAGE_LENGTH) }));
  if (!history.length) throw new Error('at least one message is required');
  const res = await openai(apiKey).chat.completions.create({
    model: chatModel(),
    messages: [{ role: 'system', content: String(system || '').slice(0, 2000) }, ...history],
    tools: [{ type: 'function', function: DRAFT_CUSTOM_FEED_TOOL }],
    temperature: 0.6,
  });
  const message = res.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.find((call) => call.function?.name === DRAFT_CUSTOM_FEED_TOOL.name);
  if (toolCall) {
    let args = {};
    try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { /* fall through with no request text */ }
    const draft = await draftCustomFeed({ apiKey, prompt: args.request || history.at(-1)?.content || '' });
    return { reply: message.content?.trim() || "Here's a draft feed based on what you described:", action: { type: 'custom_feed_draft', draft } };
  }
  const reply = message?.content?.trim();
  if (!reply) throw new Error('OpenAI returned no content');
  return { reply, action: null };
}

/** Translate a fediverse post's text, preserving mentions/hashtags/emoji as-is. */
export async function translateText({ apiKey, text, targetLang }) {
  const clean = String(text || '').slice(0, 8000);
  if (!clean) throw new Error('text is required');
  const lang = String(targetLang || '').trim();
  if (!lang) throw new Error('targetLang is required');
  const res = await openai(apiKey).chat.completions.create({
    model: chatModel(),
    messages: [
      {
        role: 'system',
        content: "Translate the user's fediverse post into the requested language. Preserve tone, "
          + 'hashtags, mentions (@user@host), and emoji as-is. Reply with the translation ONLY — '
          + 'no preamble, no quotes, no explanation.',
      },
      { role: 'user', content: `Target language: ${lang}\n\n${clean}` },
    ],
    temperature: 0.2,
  });
  const translated = res.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error('OpenAI returned no translation');
  return translated;
}

/** Pure — no network. Normalizes/validates a raw hashtag suggestion list. */
export function cleanHashtags(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((tag) => String(tag ?? '').replace(/^#/, '').trim().toLowerCase())
    .filter((tag, index, all) => /^[a-z0-9_]{2,50}$/.test(tag) && all.indexOf(tag) === index)
    .slice(0, 8);
}

export async function suggestHashtags({ apiKey, text, ownTags = [], followedTags = [] }) {
  const clean = String(text || '').slice(0, 4000);
  if (!clean) return [];
  const context = [
    ownTags.length ? `Hashtags this account has used before: ${ownTags.slice(0, 30).join(', ')}` : '',
    followedTags.length ? `Hashtags this account follows: ${followedTags.slice(0, 30).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const data = await chatJson({
    apiKey,
    system: 'Suggest fediverse hashtags for a draft post. Prefer hashtags the author already uses or '
      + 'follows when genuinely relevant, but do not force an unrelated one just to reuse it. Reply as '
      + 'JSON: {"hashtags": ["tag1", "tag2"]} — 3 to 6 lowercase entries, no "#", no duplicates.',
    prompt: `${context}\n\nDraft post:\n${clean}`.trim(),
  });
  return cleanHashtags(data.hashtags);
}

/** Pure — no network. Normalizes/validates a raw topic-recommendation list. */
export function cleanTopicRecommendations(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => {
      const hashtag = cleanHashtags([entry?.hashtag])[0];
      const reason = String(entry?.reason ?? '').trim();
      return hashtag && reason ? { hashtag, reason } : null;
    })
    .filter((entry) => entry !== null)
    .slice(0, 8);
}

/**
 * Recommend topics to explore/follow next, from the account's own posting
 * habits (not from followed/featured tags — see the note on that in
 * mastoapi.mjs, they're still dead API stubs with no real data behind them).
 */
export async function recommendTopics({ apiKey, ownTags = [], pinnedText = [] }) {
  const context = [
    ownTags.length ? `Hashtags this account has used before: ${ownTags.slice(0, 40).join(', ')}` : '',
    pinnedText.length
      ? `Posts this account has pinned (their own highlighted work):\n${pinnedText.slice(0, 5).map((t) => `- ${t}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
  if (!context) return [];
  const data = await chatJson({
    apiKey,
    system: 'Recommend fediverse hashtags/topics this account might want to follow or explore next, '
      + 'based on what they already post about and have pinned. Favor adjacent/related topics over exact '
      + 'repeats of what they already use. Reply as JSON: {"topics": [{"hashtag": "...", "reason": "..."}]}'
      + ' — 3 to 6 entries, lowercase hashtag, no "#".',
    prompt: context,
  });
  return cleanTopicRecommendations(data.topics);
}

/** Pure — no network. Normalizes/validates a raw moderation-suggestion
 * payload. `validDomains`, when given, is the ONLY pool a "domains" entry
 * may come from — see moderation-candidates.mjs's own comment for why this
 * is enforced here rather than trusted to the prompt alone: unlike an
 * invented account handle (which fails the moment Ailo tries to resolve
 * it), an invented domain would just silently "succeed" as a useless block. */
export function cleanModerationSuggestions(raw, { validDomains } = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const clean = (arr, fields) => (Array.isArray(arr) ? arr : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => Object.fromEntries(fields.map((field) => [field, String(entry[field] ?? '').trim()])))
    .filter((entry) => fields.every((field) => entry[field]))
    .slice(0, 8);
  const domains = clean(data.domains, ['domain', 'reason']);
  const allowed = Array.isArray(validDomains)
    ? new Set(validDomains.map((d) => String(d || '').toLowerCase())) : null;
  return {
    keywords: clean(data.keywords, ['keyword', 'reason']),
    domains: allowed ? domains.filter((entry) => allowed.has(entry.domain.toLowerCase())) : domains,
    accounts: clean(data.accounts, ['acct', 'reason']),
  };
}

export async function suggestModeration({
  apiKey, filterTitles = [], blockedDomains = [], mutedCount = 0, domainCandidates = [],
}) {
  const summary = [
    filterTitles.length ? `Existing keyword filters: ${filterTitles.join(', ')}` : 'No keyword filters yet.',
    blockedDomains.length ? `Blocked domains: ${blockedDomains.join(', ')}` : 'No blocked domains yet.',
    `Muted accounts: ${mutedCount}`,
    domainCandidates.length
      ? 'Domains seen among accounts already individually blocked or muted, not yet domain-blocked '
        + '(the ONLY domains you may suggest — never suggest one that is not in this list):\n'
        + domainCandidates.map((d) => `- ${d.domain} (${d.blockedAccounts} blocked, ${d.mutedAccounts} muted account(s))`).join('\n')
      : 'No domain candidates observed yet — omit the "domains" category entirely rather than guess one.',
  ].join('\n');
  const data = await chatJson({
    apiKey,
    system: "You help a fediverse user extend their moderation setup. Given what they already "
      + 'block/mute/filter, suggest a SHORT list of additional keywords, domains, or accounts likely to '
      + "match the same pattern they're already avoiding. Never invent a specific person's real account "
      + 'handle unless one was already given to you in the input — omit the "accounts" category entirely '
      + 'rather than guess one. A domain suggestion must be chosen from the candidate list given in the '
      + 'input, verbatim — never a domain you recognize or infer from general knowledge, and never a '
      + 'partial or modified form of one in the list; omit the "domains" category entirely if none of the '
      + 'candidates fit. Reply as JSON: {"keywords":[{"keyword":"...","reason":"..."}],'
      + '"domains":[{"domain":"...","reason":"..."}],"accounts":[{"acct":"...","reason":"..."}]} — omit '
      + 'any category you have nothing grounded to suggest for.',
    prompt: summary,
  });
  return cleanModerationSuggestions(data, { validDomains: domainCandidates.map((d) => d.domain) });
}

// One short plain-language paragraph recapping the past week's moderation
// activity — see mastoapi.mjs's /api/v1/ailo/ai/moderation/summarize for the
// stats shape (a mix of live totals FediPod holds and weekly counts Ailo
// tracks client-side, since filter matching happens in Ailo, not here).
export async function summarizeModeration({ apiKey, stats = {} }) {
  const summary = [
    `Blocked accounts: ${stats.blockedAccounts ?? 0} total (${stats.newBlockedAccounts ?? 0} new this week)`,
    `Muted accounts: ${stats.mutedAccounts ?? 0} total (${stats.newMutedAccounts ?? 0} new this week)`,
    `Blocked domains: ${stats.blockedDomains ?? 0} total (${stats.newBlockedDomains ?? 0} new this week)`,
    `Keyword/semantic filters: ${stats.activeFilters ?? 0} active, ${stats.activeKeywords ?? 0} keyword(s)/phrase(s) total`,
    `Posts hidden or warned by filters this week: ${stats.filteredPosts ?? 0}`,
    `Posts refused before delivery this week because of a block: ${stats.intakeBlockedPosts ?? 0}`,
  ].join('\n');
  const data = await chatJson({
    apiKey,
    system: 'You write a short weekly moderation recap for a single fediverse user, given their moderation '
      + "stats for the past 7 days. One short paragraph, 2-4 plain-language sentences, no headings, no bullet "
      + 'points, no markdown. Reference concrete numbers from the input rather than vague language. If the week '
      + 'was quiet — nothing new, nothing blocked — say so plainly rather than padding; never invent activity '
      + 'that is not in the input. Reply as JSON: {"summary": "..."}.',
    prompt: summary,
  });
  return String(data.summary || '').trim();
}

export async function embedTexts({ apiKey, texts }) {
  const list = (Array.isArray(texts) ? texts : []).map((text) => String(text || '').slice(0, 8000));
  if (!list.length) return [];
  const res = await openai(apiKey).embeddings.create({ model: embedModel(), input: list });
  return res.data.map((entry) => entry.embedding);
}

/**
 * Embedding-similarity match, mirroring the shape of the client's local
 * SemanticFilterService.apply() (renderer/lib/semantic-filter-service.ts in
 * ailo): OpenAI's text-embedding-3-* models return unit-normalized vectors,
 * so cosine similarity is a plain dot product, same as the local model.
 *
 * `defaultThreshold` is a starting point, not a tuned constant — the two
 * embedding spaces (local EmbeddingGemma vs. OpenAI text-embedding-3-small)
 * are not comparable, so the client's existing Strict/Balanced/Broad picker
 * should pass its own per-keyword threshold rather than relying on this.
 */
export async function matchByEmbedding({ apiKey, queries, documents, defaultThreshold = 0.6 }) {
  const qs = Array.isArray(queries) ? queries : [];
  const docs = Array.isArray(documents) ? documents : [];
  if (!qs.length || !docs.length) return [];
  const vectors = await embedTexts({ apiKey, texts: [...qs.map((q) => q.text), ...docs.map((d) => d.text)] });
  const queryVectors = vectors.slice(0, qs.length);
  const documentVectors = vectors.slice(qs.length);
  return matchVectors({ queries: qs, documents: docs, queryVectors, documentVectors, defaultThreshold });
}

/**
 * A minimal, cheap call used only to validate a key when Ailo's provider UI
 * tests it (POST .../test) — listing models is authenticated but generates
 * nothing, so testing a key (including one the caller hasn't saved yet)
 * costs nothing beyond the request itself.
 */
export async function verifyKey(apiKey) {
  await openai(apiKey).models.list();
  return { model: chatModel() };
}
