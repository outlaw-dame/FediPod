import assert from 'node:assert/strict';
import test from 'node:test';
import { translateText as translateDeepL } from './deepl.mjs';
import { normalizeLibreTranslateUrl, translateText as translateLibre } from './libretranslate.mjs';

function response(payload, status = 200) {
  const raw = JSON.stringify(payload);
  return new Response(raw, { status, headers: { 'content-type': 'application/json', 'content-length': String(raw.length) } });
}

test('DeepL uses header authentication and the free endpoint without leaking the key into the URL', async () => {
  let request;
  const translated = await translateDeepL({ apiKey: 'secret:fx', text: 'Hello', targetLang: 'en-US',
    fetcher: async (url, init) => { request = { url, init }; return response({ translations: [{ text: 'Hello' }] }); } });
  assert.equal(translated, 'Hello');
  assert.equal(request.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(request.init.headers.authorization, 'DeepL-Auth-Key secret:fx');
  assert.equal(request.url.includes('secret'), false);
});

test('LibreTranslate accepts HTTPS and explicit loopback HTTP but rejects risky URL shapes', () => {
  assert.equal(normalizeLibreTranslateUrl('https://translate.example/api/'), 'https://translate.example/api');
  assert.equal(normalizeLibreTranslateUrl('http://localhost:5000/translate'), 'http://localhost:5000');
  assert.throws(() => normalizeLibreTranslateUrl('http://translate.example'), /HTTPS/);
  assert.throws(() => normalizeLibreTranslateUrl('https://user:pass@translate.example'), /credentials/);
});

test('LibreTranslate sends an optional user key only to the configured endpoint', async () => {
  let request;
  const translated = await translateLibre({ apiKey: 'secret', baseUrl: 'http://127.0.0.1:5000', text: 'Hello', targetLang: 'es-MX',
    fetcher: async (url, init) => { request = { url, init }; return response({ translatedText: 'Hola' }); } });
  assert.equal(translated, 'Hola');
  assert.equal(request.url, 'http://127.0.0.1:5000/translate');
  assert.deepEqual(JSON.parse(request.init.body), { q: 'Hello', source: 'auto', target: 'es', format: 'text', api_key: 'secret' });
});
