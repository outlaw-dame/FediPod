import assert from 'node:assert/strict';
import test from 'node:test';

import { translationSettings } from './mastoapi.mjs';

function store(settings = {}, credentials = {}) {
  return { getTranslationSettings: () => settings, getProviderCredentials: () => credentials };
}

test('translation settings stay off with no provider and default on when one is configured', () => {
  const settings = translationSettings(store());
  assert.equal(settings.autoTranslate, false);
  assert.equal(settings.targetLanguage, 'en');
  assert.equal(settings.provider, null);
  assert.equal(translationSettings(store({}, { deepl: 'secret' })).autoTranslate, true);
  assert.equal(translationSettings(store({ auto_translate: false }, { deepl: 'secret' })).autoTranslate, false);
  assert.equal(translationSettings(store({ auto_translate: true })).autoTranslate, false);
});

test('translation settings retain valid owner choices and reject planted values', () => {
  const valid = translationSettings(store({
    provider: 'deepl', auto_translate: true, target_language: 'pt-BR',
  }, { deepl: 'secret' }));
  assert.equal(valid.provider, 'deepl');
  assert.equal(valid.autoTranslate, true);
  assert.equal(valid.targetLanguage, 'pt-BR');

  const invalid = translationSettings(store({
    provider: 'shell', auto_translate: 'yes', target_language: '../../etc/passwd',
  }));
  assert.equal(invalid.provider, null);
  assert.equal(invalid.autoTranslate, false);
  assert.equal(invalid.targetLanguage, 'en');
});
