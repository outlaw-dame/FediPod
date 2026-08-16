import { readCapped, safeFetch } from './safefetch.mjs';

const MAX_TEXT = 8_000;

function endpointFor(apiKey) {
  return String(apiKey || '').endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

function targetLanguage(value) {
  const normalized = String(value || '').trim().replace('_', '-').toUpperCase();
  if (!/^[A-Z]{2,3}(?:-[A-Z]{2})?$/.test(normalized)) throw new Error('target language is invalid');
  if (normalized === 'EN') return 'EN-US';
  return normalized;
}

async function jsonResponse(response) {
  const raw = await readCapped(response, 512 * 1024);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('DeepL returned an invalid response'); }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('DeepL rejected the configured API key');
    if (response.status === 429) throw new Error('DeepL rate limit reached; try again shortly');
    throw new Error(`DeepL request failed (${response.status})`);
  }
  return payload;
}

export async function translateText({ apiKey, text, targetLang, fetcher = safeFetch }) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error('text is required');
  const response = await fetcher(`${endpointFor(apiKey)}/v2/translate`, {
    method: 'POST',
    headers: { authorization: `DeepL-Auth-Key ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ text: [clean], target_lang: targetLanguage(targetLang) }),
  });
  const payload = await jsonResponse(response);
  const translated = payload?.translations?.[0]?.text;
  if (typeof translated !== 'string' || !translated.trim()) throw new Error('DeepL returned no translation');
  return translated.trim();
}

export async function verifyKey(apiKey, fetcher = safeFetch) {
  await translateText({ apiKey, text: 'Hello', targetLang: 'DE', fetcher });
  return { service: 'deepl' };
}
