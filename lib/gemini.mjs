// gemini.mjs — Gemini counterpart to ai.mjs. Same endpoints
// (/api/v1/ailo/ai/*, see mastoapi.mjs), same function names and shapes, a
// different model behind them — mastoapi.mjs picks which module answers a
// request per-call based on the resolved provider (see credentialFor()
// there), so the two are kept API-compatible on purpose rather than merged:
// one file staying OpenAI-only and one staying Gemini-only is what makes it
// obvious which SDK a given bug report belongs to.
//
// Every function takes its API key explicitly — see ai.mjs's header comment
// for why (a key saved through Ailo's provider UI has to take effect on the
// next call, not after a restart).

import { GoogleGenAI } from '@google/genai';
import { cleanHashtags, cleanTopicRecommendations, cleanModerationSuggestions } from './ai.mjs';
import { matchVectors } from './vector-match.mjs';
import { DRAFT_CUSTOM_FEED_TOOL } from './assistant-tools.mjs';

const clients = new Map();
function gemini(apiKey) {
  if (!apiKey) throw new Error('a Gemini API key is required');
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

// See ai.mjs's chatModel() — exported for the same reason.
export function chatModel() { return process.env.AP_GEMINI_MODEL || 'gemini-2.5-flash'; }
function embedModel() { return process.env.AP_GEMINI_EMBED_MODEL || 'text-embedding-004'; }

// The SDK throws with `message` set to the *raw JSON body* of Google's error
// response (e.g. '{"error":{"code":400,"message":"API key not valid...'),
// not a plain string like OpenAI's client — every call site below routes
// through here so a bad key surfaces the same one-line message OpenAI's
// side does, instead of a JSON blob leaking through to Ailo's UI.
function unwrapError(e) {
  try {
    const message = JSON.parse(e.message)?.error?.message;
    if (message) return new Error(message);
  } catch { /* not JSON — e.g. a network error, pass it through as-is */ }
  return e;
}
async function generateContent(apiKey, params) {
  try {
    return await gemini(apiKey).models.generateContent(params);
  } catch (e) {
    throw unwrapError(e);
  }
}
async function embedContent(apiKey, params) {
  try {
    return await gemini(apiKey).models.embedContent(params);
  } catch (e) {
    throw unwrapError(e);
  }
}

async function chatJson({ apiKey, system, prompt }) {
  const res = await generateContent(apiKey, {
    model: chatModel(),
    contents: prompt,
    config: { systemInstruction: system, responseMimeType: 'application/json', temperature: 0.4 },
  });
  const text = res.text;
  if (!text) throw new Error('Gemini returned no content');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini returned invalid JSON');
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
 * See ai.mjs's assistantReply — same contract, including draft_custom_feed
 * tool support. Gemini has no 'assistant' role; the API's own name for that
 * turn is 'model'. `parametersJsonSchema` (rather than `parameters`, which
 * wants Gemini's own Type-enum Schema shape) accepts the plain JSON Schema
 * DRAFT_CUSTOM_FEED_TOOL already uses, so the one shared definition works
 * unmodified for both providers.
 */
export async function assistantReply({ apiKey, system, messages }) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_ASSISTANT_MESSAGES)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.trim().slice(0, MAX_ASSISTANT_MESSAGE_LENGTH) }],
    }));
  if (!history.length) throw new Error('at least one message is required');
  const res = await generateContent(apiKey, {
    model: chatModel(),
    contents: history,
    config: {
      systemInstruction: String(system || '').slice(0, 2000),
      temperature: 0.6,
      tools: [{ functionDeclarations: [{
        name: DRAFT_CUSTOM_FEED_TOOL.name,
        description: DRAFT_CUSTOM_FEED_TOOL.description,
        parametersJsonSchema: DRAFT_CUSTOM_FEED_TOOL.parameters,
      }] }],
    },
  });
  const call = res.functionCalls?.find((fc) => fc.name === DRAFT_CUSTOM_FEED_TOOL.name);
  if (call) {
    const request = typeof call.args?.request === 'string' ? call.args.request : history.at(-1)?.parts[0]?.text || '';
    const draft = await draftCustomFeed({ apiKey, prompt: request });
    return { reply: res.text?.trim() || "Here's a draft feed based on what you described:", action: { type: 'custom_feed_draft', draft } };
  }
  const reply = res.text?.trim();
  if (!reply) throw new Error('Gemini returned no content');
  return { reply, action: null };
}

/** Translate a fediverse post's text, preserving mentions/hashtags/emoji as-is. */
export async function translateText({ apiKey, text, targetLang }) {
  const clean = String(text || '').slice(0, 8000);
  if (!clean) throw new Error('text is required');
  const lang = String(targetLang || '').trim();
  if (!lang) throw new Error('targetLang is required');
  const res = await generateContent(apiKey, {
    model: chatModel(),
    contents: `Target language: ${lang}\n\n${clean}`,
    config: {
      systemInstruction: "Translate the user's fediverse post into the requested language. Preserve tone, "
        + 'hashtags, mentions (@user@host), and emoji as-is. Reply with the translation ONLY — '
        + 'no preamble, no quotes, no explanation.',
      temperature: 0.2,
    },
  });
  const translated = res.text?.trim();
  if (!translated) throw new Error('Gemini returned no translation');
  return translated;
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

export async function suggestModeration({ apiKey, filterTitles = [], blockedDomains = [], mutedCount = 0 }) {
  const summary = [
    filterTitles.length ? `Existing keyword filters: ${filterTitles.join(', ')}` : 'No keyword filters yet.',
    blockedDomains.length ? `Blocked domains: ${blockedDomains.join(', ')}` : 'No blocked domains yet.',
    `Muted accounts: ${mutedCount}`,
  ].join('\n');
  const data = await chatJson({
    apiKey,
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

export async function embedTexts({ apiKey, texts }) {
  const list = (Array.isArray(texts) ? texts : []).map((text) => String(text || '').slice(0, 8000));
  if (!list.length) return [];
  const res = await embedContent(apiKey, { model: embedModel(), contents: list });
  return (res.embeddings || []).map((entry) => entry.values || []);
}

/** See ai.mjs's matchByEmbedding — same contract, Gemini embeddings underneath. */
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
 * tests it (POST .../test) — real content, but the smallest prompt that
 * still proves the key/model pair actually works end to end.
 */
export async function verifyKey(apiKey) {
  const res = await generateContent(apiKey, { model: chatModel(), contents: 'Reply with OK.' });
  if (!res.text) throw new Error('Gemini returned no content');
  return { model: chatModel() };
}
