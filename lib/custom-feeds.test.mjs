import test from 'node:test';
import assert from 'node:assert/strict';
import {
  customFeedMatchesExact, normalizeAccount, normalizeCustomFeed, normalizeDomain, statusIsVisible,
} from './custom-feeds.mjs';

test('custom feeds preserve phrases and normalize account and hashtag rules', () => {
  const feed = normalizeCustomFeed({
    name: ' Climate ', description: 'Independent reporting', avatar_url: 'https://media.example/avatar.webp',
    accounts: ['@Alice@Example.COM', 'alice@example.com'],
    hashtags: ['#Climate', 'climate'], semantic_keywords: ['renewable energy transition'],
    exclude_words: [' Spoiler '], exclude_accounts: ['@bot@example.net'],
  }, { id: 'one', createdAt: 'then' });
  assert.deepEqual(feed.accounts, ['alice@example.com']);
  assert.deepEqual(feed.hashtags, ['climate']);
  assert.deepEqual(feed.semanticKeywords, ['renewable energy transition']);
  assert.deepEqual(feed.excludeWords, ['spoiler']);
  assert.equal(feed.description, 'Independent reporting');
  assert.equal(feed.avatarUrl, 'https://media.example/avatar.webp');
  assert.equal(feed.bannerUrl, null);
  assert.equal(normalizeAccount('@@A@B.COM'), 'a@b.com');
});

test('custom feed image URLs fail closed on unsafe schemes', () => {
  assert.throws(() => normalizeCustomFeed({ name: 'Unsafe', hashtags: ['news'], avatar_url: 'file:///etc/passwd' }), /http or https/);
});

test('custom feed must have an inclusive rule', () => {
  assert.throws(() => normalizeCustomFeed({ name: 'Empty' }), /at least one/);
});

test('domain blocks are canonical and reject paths and malformed labels', () => {
  assert.equal(normalizeDomain('*.News.Example.'), 'news.example');
  assert.equal(normalizeDomain('news.example/path'), null);
  assert.equal(normalizeDomain('-bad.example'), null);
});

test('candidate visibility applies private, mute, actor block, and domain block first', () => {
  const store = {
    getMuted: () => ({ actors: ['https://mute.example/u/a'] }),
    isBlocked: (url) => new URL(url).hostname.endsWith('blocked.example'),
  };
  assert.equal(statusIsVisible(store, { actor: 'https://ok.example/u/a', visibility: 'public', kind: 'timeline' }), true);
  assert.equal(statusIsVisible(store, { actor: 'https://ok.example/u/a', visibility: 'private', kind: 'timeline' }), false);
  assert.equal(statusIsVisible(store, { actor: 'https://mute.example/u/a', visibility: 'public', kind: 'timeline' }), false);
  assert.equal(statusIsVisible(store, { actor: 'https://sub.blocked.example/u/a', visibility: 'public', kind: 'timeline' }), false);
});

test('customFeedMatchesExact matches accounts, hashtags, and literal phrases', () => {
  const feed = normalizeCustomFeed({
    name: 'FF7', hashtags: ['ff7rebirth'], accounts: ['alice@example.social'],
    semantic_keywords: ['crisis core reunion'],
  });
  assert.equal(customFeedMatchesExact(feed, { account: 'alice@example.social', hashtags: [], text: 'unrelated' }), true, 'account match');
  assert.equal(customFeedMatchesExact(feed, { account: 'bob@example.social', hashtags: ['ff7rebirth'], text: 'new trailer' }), true, 'hashtag match');
  assert.equal(customFeedMatchesExact(feed, { account: 'bob@example.social', hashtags: [], text: 'Crisis Core Reunion is great' }), true, 'literal phrase match, case-insensitive');
  assert.equal(customFeedMatchesExact(feed, { account: 'bob@example.social', hashtags: [], text: 'lasagna recipe' }), false, 'no rule matches');
});

test('customFeedMatchesExact: excludes win over every inclusive rule', () => {
  const feed = normalizeCustomFeed({
    name: 'FF7', hashtags: ['ff7rebirth'], exclude_accounts: ['spoilers@example.social'], exclude_words: ['spoiler'],
  });
  assert.equal(customFeedMatchesExact(feed, { account: 'spoilers@example.social', hashtags: ['ff7rebirth'], text: 'new trailer' }), false, 'excluded account wins over a hashtag match');
  assert.equal(customFeedMatchesExact(feed, { account: 'bob@example.social', hashtags: ['ff7rebirth'], text: 'huge SPOILER inside' }), false, 'excluded word wins, case-insensitively');
});

test('customFeedMatchesExact is case-insensitive on the account side, matching Ailo\'s client-side rule', () => {
  const feed = normalizeCustomFeed({ name: 'FF7', accounts: ['Alice@Example.Social'] });
  assert.equal(customFeedMatchesExact(feed, { account: 'alice@example.social', hashtags: [], text: '' }), true);
});
