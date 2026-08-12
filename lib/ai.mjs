// ai.mjs — thin wrapper around the OpenAI SDK for the Ailo/FediPod extension
// endpoints (/api/v1/ailo/ai/*, see mastoapi.mjs). Nothing here sits on the
// standard ActivityPub/Mastodon wire path.
//
// Every env read is LAZY (inside a function, at call time) rather than a
// module-level constant: this file is reached via a static import chain
// (mastoapi.mjs → ... → run-agent.mjs), and static imports are hoisted and
// evaluated before dotenv has run (see run-agent.mjs's comment on
// loadDotenv()) — a top-level `process.env.AP_OPENAI_API_KEY` read here
// would silently see `undefined` even when a real .env exists.
//
// With no AP_OPENAI_API_KEY set, isAiEnabled() is false and mastoapi.mjs
// answers 503 for every /api/v1/ailo/ai/* route without ever reaching this
// module's network-calling functions.

import OpenAI from 'openai';

let client = null;
function openai() {
  if (client) return client;
  const apiKey = process.env.AP_OPENAI_API_KEY;
  if (!apiKey) throw new Error('AP_OPENAI_API_KEY is not set');
  client = new OpenAI({ apiKey });
  return client;
}

export function isAiEnabled() {
  return Boolean(process.env.AP_OPENAI_API_KEY);
}

function chatModel() { return process.env.AP_OPENAI_MODEL || 'gpt-4o-mini'; }
function embedModel() { return process.env.AP_OPENAI_EMBED_MODEL || 'text-embedding-3-small'; }

async function chatJson({ system, prompt }) {
  const res = await openai().chat.completions.create({
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

/** Translate a fediverse post's text, preserving mentions/hashtags/emoji as-is. */
export async function translateText({ text, targetLang }) {
  const clean = String(text || '').slice(0, 8000);
  if (!clean) throw new Error('text is required');
  const lang = String(targetLang || '').trim();
  if (!lang) throw new Error('targetLang is required');
  const res = await openai().chat.completions.create({
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

export async function suggestHashtags({ text, ownTags = [], followedTags = [] }) {
  const clean = String(text || '').slice(0, 4000);
  if (!clean) return [];
  const context = [
    ownTags.length ? `Hashtags this account has used before: ${ownTags.slice(0, 30).join(', ')}` : '',
    followedTags.length ? `Hashtags this account follows: ${followedTags.slice(0, 30).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const data = await chatJson({
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
export async function recommendTopics({ ownTags = [], pinnedText = [] }) {
  const context = [
    ownTags.length ? `Hashtags this account has used before: ${ownTags.slice(0, 40).join(', ')}` : '',
    pinnedText.length
      ? `Posts this account has pinned (their own highlighted work):\n${pinnedText.slice(0, 5).map((t) => `- ${t}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
  if (!context) return [];
  const data = await chatJson({
    system: 'Recommend fediverse hashtags/topics this account might want to follow or explore next, '
      + 'based on what they already post about and have pinned. Favor adjacent/related topics over exact '
      + 'repeats of what they already use. Reply as JSON: {"topics": [{"hashtag": "...", "reason": "..."}]}'
      + ' — 3 to 6 entries, lowercase hashtag, no "#".',
    prompt: context,
  });
  return cleanTopicRecommendations(data.topics);
}

/** Pure — no network. Normalizes/validates a raw moderation-suggestion payload. */
export function cleanModerationSuggestions(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const clean = (arr, fields) => (Array.isArray(arr) ? arr : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => Object.fromEntries(fields.map((field) => [field, String(entry[field] ?? '').trim()])))
    .filter((entry) => fields.every((field) => entry[field]))
    .slice(0, 8);
  return {
    keywords: clean(data.keywords, ['keyword', 'reason']),
    domains: clean(data.domains, ['domain', 'reason']),
    accounts: clean(data.accounts, ['acct', 'reason']),
  };
}

export async function suggestModeration({ filterTitles = [], blockedDomains = [], mutedCount = 0 }) {
  const summary = [
    filterTitles.length ? `Existing keyword filters: ${filterTitles.join(', ')}` : 'No keyword filters yet.',
    blockedDomains.length ? `Blocked domains: ${blockedDomains.join(', ')}` : 'No blocked domains yet.',
    `Muted accounts: ${mutedCount}`,
  ].join('\n');
  const data = await chatJson({
    system: "You help a fediverse user extend their moderation setup. Given what they already "
      + 'block/mute/filter, suggest a SHORT list of additional keywords, domains, or accounts likely to '
      + "match the same pattern they're already avoiding. Never invent a specific person's real account "
      + 'handle unless one was already given to you in the input — omit the "accounts" category entirely '
      + 'rather than guess one. Reply as JSON: {"keywords":[{"keyword":"...","reason":"..."}],'
      + '"domains":[{"domain":"...","reason":"..."}],"accounts":[{"acct":"...","reason":"..."}]} — omit '
      + 'any category you have nothing grounded to suggest for.',
    prompt: summary,
  });
  return cleanModerationSuggestions(data);
}

export async function embedTexts(texts) {
  const list = (Array.isArray(texts) ? texts : []).map((text) => String(text || '').slice(0, 8000));
  if (!list.length) return [];
  const res = await openai().embeddings.create({ model: embedModel(), input: list });
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
export async function matchByEmbedding({ queries, documents, defaultThreshold = 0.6 }) {
  const qs = Array.isArray(queries) ? queries : [];
  const docs = Array.isArray(documents) ? documents : [];
  if (!qs.length || !docs.length) return [];
  const vectors = await embedTexts([...qs.map((q) => q.text), ...docs.map((d) => d.text)]);
  const qVecs = vectors.slice(0, qs.length);
  const dVecs = vectors.slice(qs.length);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * (b[i] || 0), 0);
  const matches = [];
  qs.forEach((q, qi) => {
    const threshold = Number.isFinite(q.threshold) ? q.threshold : defaultThreshold;
    docs.forEach((d, di) => {
      const score = dot(qVecs[qi], dVecs[di]);
      if (score >= threshold) matches.push({ queryId: q.id, documentId: d.id, score });
    });
  });
  return matches;
}
