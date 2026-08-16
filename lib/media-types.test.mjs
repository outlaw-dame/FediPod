import assert from 'node:assert/strict';
import test from 'node:test';

import { attachmentType, extensionFor } from './mastoapi.mjs';

test('accepts open web media formats and assigns interoperable extensions', () => {
  assert.equal(attachmentType('video/webm; codecs="vp9,opus"'), 'video/webm');
  assert.equal(attachmentType('video/ogg'), 'video/ogg');
  assert.equal(attachmentType('video/x-matroska'), 'video/x-matroska');
  assert.equal(attachmentType('image/webp'), 'image/webp');
  assert.equal(extensionFor('video/x-matroska', 'clip.mkv'), 'mkv');
  assert.equal(extensionFor('video/ogg', 'clip.ogv'), 'ogv');
});

test('fails closed for executable and unknown attachment types', () => {
  assert.equal(attachmentType('image/svg+xml'), 'application/octet-stream');
  assert.equal(attachmentType('text/html'), 'application/octet-stream');
  assert.equal(attachmentType('video/not-a-codec'), 'application/octet-stream');
  assert.equal(extensionFor('application/octet-stream', 'attack.html'), 'bin');
});
