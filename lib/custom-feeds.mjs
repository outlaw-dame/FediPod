const MAX_FEEDS = 100;
const MAX_RULES = 100;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_TERM = 200;

const clean = (value, max = MAX_TERM) => String(value ?? '').trim().slice(0, max);
const unique = (values, normalize = (value) => value) => [...new Set(
  (Array.isArray(values) ? values : []).map((value) => normalize(clean(value))).filter(Boolean),
)].slice(0, MAX_RULES);

export function normalizeAccount(value) {
  return clean(value).replace(/^@+/, '').toLowerCase();
}

export function normalizeHashtag(value) {
  const tag = clean(value).replace(/^#+/, '').normalize('NFKC').toLocaleLowerCase();
  return /^[\p{L}\p{M}\p{N}_]+$/u.test(tag) && !/^\p{N}+$/u.test(tag) ? tag : '';
}

export function normalizeDomain(value) {
  const input = clean(value, 253).replace(/^\*\./, '').replace(/\.$/, '').toLowerCase();
  if (!input || input.includes('/') || input.includes('@') || input.includes(':')) return null;
  try {
    const host = new URL(`https://${input}`).hostname.toLowerCase();
    if (host.length > 253 || !host.includes('.')) return null;
    if (host.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return host;
  } catch { return null; }
}

function normalizeImageUrl(value) {
  const input = clean(value, 2048);
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    return url.href;
  } catch { throw new Error('feed images must use an http or https URL'); }
}

export function normalizeCustomFeed(input, existing = {}) {
  const name = clean(input?.name, MAX_NAME);
  if (!name) throw new Error('a feed name is required');
  const feed = {
    id: existing.id,
    name,
    description: clean(input?.description, MAX_DESCRIPTION),
    avatarUrl: normalizeImageUrl(input?.avatar_url ?? input?.avatarUrl),
    bannerUrl: normalizeImageUrl(input?.banner_url ?? input?.bannerUrl),
    accounts: unique(input?.accounts, normalizeAccount),
    hashtags: unique(input?.hashtags, normalizeHashtag),
    semanticKeywords: unique(input?.semantic_keywords ?? input?.semanticKeywords),
    excludeWords: unique(input?.exclude_words ?? input?.excludeWords, (value) => value.toLocaleLowerCase()),
    excludeAccounts: unique(input?.exclude_accounts ?? input?.excludeAccounts, normalizeAccount),
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  if (!feed.accounts.length && !feed.hashtags.length && !feed.semanticKeywords.length) {
    throw new Error('add at least one account, hashtag, or topic phrase');
  }
  return feed;
}

export function customFeedJson(feed) {
  return {
    id: feed.id,
    name: feed.name,
    description: feed.description || '',
    avatar_url: feed.avatarUrl || null,
    banner_url: feed.bannerUrl || null,
    accounts: feed.accounts || [],
    hashtags: feed.hashtags || [],
    semantic_keywords: feed.semanticKeywords || [],
    exclude_words: feed.excludeWords || [],
    exclude_accounts: feed.excludeAccounts || [],
    created_at: feed.createdAt,
    updated_at: feed.updatedAt,
  };
}

export function canAddCustomFeed(feeds) {
  return Array.isArray(feeds) && feeds.length < MAX_FEEDS;
}

// Same precedence Ailo's renderer/lib/custom-feed-match.ts applies
// client-side (exclude wins, then account/hashtag/literal-phrase in that
// order) — the server-side copy exists only so GET .../timeline can put a
// feed's own matching posts ahead of an unrelated recency cutoff (see the
// route's own comment for why that matters); Ailo still re-applies this
// AND its own embedding-based semantic matching against whatever candidate
// pool the route hands back, so this staying in sync with the client copy
// only ever narrows or widens which posts get a head start, never which
// posts are considered a match at all.
export function customFeedMatchesExact(feed, { account, hashtags, text }) {
  const excludeAccounts = new Set((feed.excludeAccounts || []).map((a) => normalizeAccount(a)));
  if (account && excludeAccounts.has(account)) return false;
  const lower = String(text || '').toLocaleLowerCase();
  if ((feed.excludeWords || []).some((word) => lower.includes(String(word).toLocaleLowerCase()))) return false;
  if (account && (feed.accounts || []).some((a) => normalizeAccount(a) === account)) return true;
  const tagSet = new Set((hashtags || []).map((t) => String(t).toLocaleLowerCase()));
  if ((feed.hashtags || []).some((t) => tagSet.has(normalizeHashtag(t)))) return true;
  return (feed.semanticKeywords || []).some((phrase) => lower.includes(String(phrase).toLocaleLowerCase()));
}

export function statusIsVisible(store, status) {
  if (!status || status.direct || status.visibility === 'direct' || status.visibility === 'private') return false;
  if (status.kind === 'remote' || status.kind === 'mention') return false;
  const muted = new Set(store.getMuted().actors || []);
  if (muted.has(status.actor) || muted.has(status.via)) return false;
  if (store.isBlocked(status.actor) || (status.via && store.isBlocked(status.via))) return false;
  return true;
}
