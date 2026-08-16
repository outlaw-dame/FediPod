const API_ORIGIN = 'https://api.klipy.com';
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 24;

function asHttpsUrl(value) {
  try { const url = new URL(String(value || '')); return url.protocol === 'https:' ? url.href : null; }
  catch { return null; }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nativeResult(item) {
  const formats = item?.file || {};
  const original = formats.hd?.gif || formats.md?.gif || formats.sm?.gif || formats.xs?.gif;
  const preview = formats.sm?.webp || formats.xs?.webp || formats.sm?.gif || original;
  const url = asHttpsUrl(original?.url);
  if (!url) return null;
  return { id: String(item.id || item.slug || url), title: String(item.title || item.slug || 'GIF').slice(0, 300),
    url, preview_url: asHttpsUrl(preview?.url) || url, width: positiveNumber(original?.width), height: positiveNumber(original?.height) };
}

function tenorResult(item) {
  const formats = item?.media_formats || {};
  const original = formats.gif || formats.mediumgif || formats.tinygif;
  const preview = formats.tinywebp || formats.nanowebp || formats.tinygif || original;
  const url = asHttpsUrl(original?.url);
  if (!url) return null;
  const dims = Array.isArray(original?.dims) ? original.dims : [];
  return { id: String(item.id || url), title: String(item.content_description || item.title || 'GIF').slice(0, 300),
    url, preview_url: asHttpsUrl(preview?.url) || url, width: positiveNumber(dims[0]), height: positiveNumber(dims[1]) };
}

export function parseKlipyResults(payload) {
  const native = payload?.data?.data;
  const tenor = payload?.results;
  const rows = Array.isArray(native) ? native : Array.isArray(tenor) ? tenor : [];
  const mapper = Array.isArray(native) ? nativeResult : tenorResult;
  return rows.map(mapper).filter(Boolean);
}

export async function searchGifs({ apiKey, query, limit = 20, fetcher = fetch }) {
  const q = String(query || '').trim();
  if (!q || [...q].length > 100) throw new Error('GIF search must contain 1–100 characters');
  const count = Math.min(Math.max(Number(limit) || 20, 1), MAX_RESULTS);
  const url = new URL(`/api/v1/${encodeURIComponent(apiKey)}/gifs/search`, API_ORIGIN);
  url.searchParams.set('q', q); url.searchParams.set('page', '1'); url.searchParams.set('per_page', String(count));
  // Integration ID only: never send the account ID, WebID, handle, or another cross-service identifier.
  url.searchParams.set('customer_id', 'ailo-fedipod');
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS), headers: { accept: 'application/json' } }); }
  catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('KLIPY search timed out');
    throw new Error('KLIPY search is unavailable');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('KLIPY rejected the configured API key');
    if (response.status === 429) throw new Error('KLIPY rate limit reached; try again shortly');
    throw new Error(`KLIPY search failed (${response.status})`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('KLIPY returned an invalid response'); }
  if (payload?.result === false) throw new Error('KLIPY rejected the search request');
  return parseKlipyResults(payload).slice(0, count);
}

export async function verifyKey(apiKey, fetcher = fetch) {
  await searchGifs({ apiKey, query: 'hello', limit: 1, fetcher });
  return { service: 'klipy' };
}
