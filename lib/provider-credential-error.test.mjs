import test from 'node:test';
import assert from 'node:assert/strict';
import { providerCredentialFailure } from './mastoapi.mjs';

test('invalid Gemini credentials return validation guidance, not a daemon auth failure', () => {
  assert.deepEqual(providerCredentialFailure('gemini', new Error('Request had invalid authentication credentials')), {
    status: 422,
    error: 'Gemini rejected this API key. Use an API key from Google AI Studio, not an OAuth or Google Cloud access token.',
  });
});

test('provider availability errors remain upstream failures', () => {
  assert.deepEqual(providerCredentialFailure('openai', new Error('network unavailable')), {
    status: 502, error: 'network unavailable',
  });
});

test('translation and media providers classify their rejected-key wording', () => {
  for (const provider of ['deepl', 'libretranslate', 'klipy']) {
    assert.equal(providerCredentialFailure(provider, new Error(`${provider} rejected the configured API key`)).status, 422);
  }
  assert.equal(providerCredentialFailure('safe_browsing', new Error('API key not valid.')).status, 422);
  assert.equal(providerCredentialFailure('openai', new Error('Incorrect API key provided')).status, 422);
});
