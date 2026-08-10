import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiService, SafeBrowsingService } from '../../lib/ai.mjs';
import { ProviderSecretStore } from '../../lib/provider-secrets.mjs';

const jsonResponse = body => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-provider-secrets-'));
  try {
    const credentials = new ProviderSecretStore({
      home,
      env: { AP_OPENAI_API_KEY: 'environment-openai' },
    });
    assert.deepEqual(credentials.status(), {
      openai: { configured: true, source: 'environment' },
      gemini: { configured: false, source: null },
      safe_browsing: { configured: false, source: null },
    });
    credentials.set('openai', 'local-openai');
    credentials.set('gemini', 'local-gemini');
    assert.equal(credentials.key('openai'), 'local-openai', 'local key overrides environment fallback');
    assert.equal(fs.statSync(path.join(home, 'provider-secrets.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(credentials.status()), /local-openai|local-gemini/,
      'status never exposes stored secrets');

    const ai = new AiService({ credentials, env: {} });
    assert.deepEqual(ai.providers(), ['openai', 'gemini']);
    assert.equal(ai.requireProvider(), 'openai', 'a newly added key becomes the live default without restart');
    credentials.delete('gemini');
    assert.deepEqual(ai.providers(), ['openai'], 'credential changes apply without restarting FediPod');
    credentials.delete('openai');
    assert.equal(credentials.key('openai'), 'environment-openai', 'removal restores environment fallback');

    fs.unlinkSync(path.join(home, 'provider-secrets.json'));
    fs.symlinkSync(path.join(home, 'elsewhere.json'), path.join(home, 'provider-secrets.json'));
    assert.throws(() => credentials.status(), /regular file/, 'symbolic-link stores are rejected');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

{
  const calls = [];
  const ai = new AiService({
    env: { AP_OPENAI_API_KEY: 'openai-secret', AP_GEMINI_API_KEY: 'gemini-secret', AP_AI_PROVIDER: 'gemini' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"hashtags":["Fediverse","open_web"]}' }] } }] });
    },
  });
  assert.deepEqual(ai.status(true), {
    enabled: true, providers: ['openai', 'gemini'], default_provider: 'gemini',
    models: { openai: 'gpt-4.1-mini', gemini: 'gemini-3.6-flash' },
    safe_browsing: { enabled: true },
  });
  assert.deepEqual(await ai.hashtags('gemini', 'An open social web'), { hashtags: ['Fediverse', 'open_web'] });
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'gemini-secret');
  assert.ok(!calls[0].url.includes('gemini-secret'), 'Gemini key is not placed in a URL');
}

{
  let request;
  const ai = new AiService({
    env: { AP_OPENAI_API_KEY: 'openai-secret' },
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return jsonResponse({ choices: [{ message: { content: '{"translated":"Bonjour"}' } }] });
    },
  });
  assert.deepEqual(await ai.translate('openai', 'Hello', 'fr'), { translated: 'Bonjour' });
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer openai-secret');
  assert.match(request.init.body, /json_schema/);
  await assert.rejects(() => ai.translate('other', 'Hello', 'fr'), /Unsupported AI provider/);
}

{
  const ai = new AiService({
    env: { AP_GEMINI_API_KEY: 'gemini-secret' },
    fetchImpl: async () => jsonResponse({ embeddings: [
      { values: [3, 0] }, { values: [2.7, 0.3] }, { values: [0, 4] },
    ] }),
  });
  assert.deepEqual(await ai.matchFilters('gemini',
    [{ id: 'q', text: 'query', threshold: 0.8 }],
    [{ id: 'near', text: 'near' }, { id: 'far', text: 'far' }]),
  { matches: [{ queryId: 'q', documentId: 'near' }] });
}

{
  let calls = 0;
  const safe = new SafeBrowsingService({
    env: { AP_GOOGLE_SAFE_BROWSING_API_KEY: 'safe-secret' },
    fetchImpl: async (url, init) => {
      calls++;
      const request = new URL(url);
      assert.equal(request.origin, 'https://safebrowsing.googleapis.com');
      assert.equal(request.pathname, '/v5/urls:search');
      assert.deepEqual(request.searchParams.getAll('urls'), ['https://example.test/path']);
      assert.equal(init.headers['x-goog-api-key'], 'safe-secret');
      assert.ok(!request.href.includes('safe-secret'), 'Safe Browsing key is not placed in a URL');
      return jsonResponse({ threats: [], cacheDuration: '60s' });
    },
  });
  const first = await safe.check(['https://example.test/path#fragment']);
  const second = await safe.check(['https://example.test/path']);
  assert.equal(first.safe, true);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1, 'Safe Browsing honors the server cache duration');
  await assert.rejects(() => safe.check(['file:///etc/passwd']), /only credential-free http/);
}

console.log('ai + safe browsing smoke: green');
