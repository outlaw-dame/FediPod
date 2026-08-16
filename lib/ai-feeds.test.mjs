import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCustomFeedDraft } from './ai.mjs';

test('AI feed drafts are bounded and keep only normalized fields', () => {
  const draft = cleanCustomFeedDraft({ name: ' News ', description: 'Daily', hashtags: ['#News', '#News'], accounts: [null], semantic_keywords: ['civic media'] });
  assert.equal(draft.name, 'News');
  assert.deepEqual(draft.hashtags, ['News']);
  assert.deepEqual(draft.accounts, []);
  assert.equal(draft.avatar_url, null);
});
