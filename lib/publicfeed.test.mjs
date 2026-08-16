import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePublicStatus } from './publicfeed.mjs';

function status(language) {
  const now = new Date().toISOString();
  return {
    uri: 'https://social.example/users/alice/statuses/1',
    account: { uri: 'https://social.example/users/alice', username: 'alice' },
    visibility: 'public', created_at: now, content: '<p>Bonjour</p>', language,
  };
}

test('public feed keeps only valid status language metadata', () => {
  assert.equal(normalizePublicStatus(status('fr'))?.status.language, 'fr');
  assert.equal(normalizePublicStatus(status('pt-BR'))?.status.language, 'pt-BR');
  assert.equal(normalizePublicStatus(status('../../etc/passwd'))?.status.language, undefined);
});

test('public feed preserves WebM/WebP types and safe preview images', () => {
  const raw = status('en');
  raw.media_attachments = [{
    type: 'video',
    url: 'https://social.example/media/clip.webm',
    preview_url: 'https://social.example/media/clip-preview.webp',
  }];
  const attachment = normalizePublicStatus(raw)?.status.attachments?.[0];
  assert.equal(attachment?.mediaType, 'video/webm');
  assert.equal(attachment?.previewUrl, 'https://social.example/media/clip-preview.webp');
});
