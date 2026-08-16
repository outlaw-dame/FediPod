import assert from 'node:assert/strict';
import test from 'node:test';

import { candidateModerationDomains } from './moderation-candidates.mjs';

test('tallies blocked and muted actors by hostname, sorted by strength of signal', () => {
  const result = candidateModerationDomains({
    blockedActors: [
      'https://spam.example/users/one',
      'https://spam.example/users/two',
      'https://junk.social/users/three',
    ],
    mutedActors: ['https://junk.social/users/four', 'https://quiet.example/users/five'],
  });
  assert.deepEqual(result, [
    { domain: 'spam.example', blockedAccounts: 2, mutedAccounts: 0 },
    { domain: 'junk.social', blockedAccounts: 1, mutedAccounts: 1 },
    { domain: 'quiet.example', blockedAccounts: 0, mutedAccounts: 1 },
  ]);
});

test('excludes a domain already covered by an existing domain block', () => {
  const result = candidateModerationDomains({
    blockedActors: ['https://spam.example/users/one', 'https://ok.example/users/two'],
    blockedDomains: ['spam.example'],
  });
  assert.deepEqual(result, [{ domain: 'ok.example', blockedAccounts: 1, mutedAccounts: 0 }]);
});

test('ignores an unparsable actor URL rather than throwing', () => {
  const result = candidateModerationDomains({ blockedActors: ['not a url', 'https://ok.example/users/one'] });
  assert.deepEqual(result, [{ domain: 'ok.example', blockedAccounts: 1, mutedAccounts: 0 }]);
});

test('returns nothing when there is no signal at all', () => {
  assert.deepEqual(candidateModerationDomains({}), []);
  assert.deepEqual(candidateModerationDomains(), []);
});

test('caps the result at 20 domains', () => {
  const blockedActors = Array.from({ length: 30 }, (_, i) => `https://host${i}.example/users/x`);
  assert.equal(candidateModerationDomains({ blockedActors }).length, 20);
});
