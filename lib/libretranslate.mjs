import { isLoopbackHost, readCapped, safeFetch } from './safefetch.mjs';

export function normalizeLibreTranslateUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('LibreTranslate URL is invalid'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('LibreTranslate URL cannot contain credentials, a query, or a fragment');
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('LibreTranslate must use HTTPS, except on this machine');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/translate$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

function targetLanguage(value) {
  const lang = String(value || '').trim().replace('_', '-').toLowerCase().split('-')[0];
  if (!/^[a-z]{2,3}$/.test(lang)) throw new Error('target language is invalid');
  return lang;
}

async function request(url, init, fetcher) {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return fetcher(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  }
  return safeFetch(url, init, fetcher);
}

export async function translateText({ apiKey, baseUrl, text, targetLang, fetcher = fetch }) {
  const clean = String(text || '').trim().slice(0, 8_000);
  if (!clean) throw new Error('text is required');
  const endpoint = `${normalizeLibreTranslateUrl(baseUrl)}/translate`;
  let response;
  try {
    response = await request(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ q: clean, source: 'auto', target: targetLanguage(targetLang), format: 'text',
        ...(apiKey ? { api_key: apiKey } : {}) }),
    }, fetcher);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('LibreTranslate request timed out');
    throw error;
  }
  const raw = await readCapped(response, 512 * 1024);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('LibreTranslate returned an invalid response'); }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('LibreTranslate rejected the configured API key');
    if (response.status === 429) throw new Error('LibreTranslate rate limit reached; try again shortly');
    throw new Error(`LibreTranslate request failed (${response.status})`);
  }
  if (typeof payload?.translatedText !== 'string' || !payload.translatedText.trim()) {
    throw new Error('LibreTranslate returned no translation');
  }
  return payload.translatedText.trim();
}

export async function verifyKey(apiKey, { baseUrl = 'https://libretranslate.com', fetcher = fetch } = {}) {
  await translateText({ apiKey, baseUrl, text: 'Hello', targetLang: 'es', fetcher });
  return { service: 'libretranslate' };
}
