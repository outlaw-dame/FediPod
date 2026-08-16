import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomFeedSources } from './custom-feed-sources.mjs';

function fakeStore({ feeds = [], following = [], blocked = [] } = {}) {
  const statuses = [];
  return {
    getCustomFeeds: () => feeds,
    getContacts: () => ({ followers: [], following }),
    getActors: () => ({}),
    getStatuses: () => statuses,
    isBlocked: (u) => blocked.some((b) => String(u).startsWith(b)),
    addStatus: (s) => statuses.push(s),
    write: () => {},
  };
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

const outboxDoc = (owner, items) => ({ id: `${owner}/outbox`, type: 'OrderedCollection', orderedItems: items });
const note = (owner, id, content = 'hi') =>
  ({ id: `${owner}/notes/${id}`, type: 'Note', content, attributedTo: owner });

const noAiConfigured = () => ({ error: 'AI features are not configured on this agent' });

function build({ store, resolved = {}, fetchAP, fetcher, aiBackendFor = noAiConfigured }) {
  const intake = { fetchAP };
  // agent: { store } — real enough for sweep()'s own syncRelayTagFollows()
  // safety-net call: a fixture with no hashtags has nothing to reconcile and
  // never touches followActor/unfollowActor; one with hashtags needs a real
  // publisher too, since a new relay follow republishes the following
  // collection — provided per-test below where that path is exercised.
  return new CustomFeedSources({
    store, intake, agent: { store, publisher: { publishCollections: async () => {} } }, log: () => {},
    resolveHandle: async (_agent, acct) => resolved[acct] ?? (() => { throw new Error(`no fixture for ${acct}`); })(),
    aiBackendFor,
    ...(fetcher ? { fetcher } : {}),
  });
}

test('sweeps an unfollowed account\'s outbox and ingests its own new notes', async () => {
  const owner = 'https://remote.example/u/alice';
  const store = fakeStore({ feeds: [{ accounts: ['alice@remote.example'], excludeAccounts: [] }] });
  const sources = build({
    store,
    resolved: { 'alice@remote.example': { id: owner, outbox: `${owner}/outbox` } },
    fetchAP: async (url) => (url === `${owner}/outbox`
      ? outboxDoc(owner, [note(owner, 1), note(owner, 2)])
      : null),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 2);
  assert.equal(sources.lastAdded, 2);
});

test('does not sweep an account the pod already follows', async () => {
  const owner = 'https://remote.example/u/alice';
  const store = fakeStore({
    feeds: [{ accounts: ['alice@remote.example'], excludeAccounts: [] }],
    following: [{ actor: owner, accepted: true }],
  });
  const sources = build({
    store,
    resolved: {},
    fetchAP: async () => { throw new Error('should never be called'); },
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 0);
});

test('refuses a note the outbox owner does not actually attribute to themselves', async () => {
  const owner = 'https://remote.example/u/alice';
  const store = fakeStore({ feeds: [{ accounts: ['alice@remote.example'], excludeAccounts: [] }] });
  const sources = build({
    store,
    resolved: { 'alice@remote.example': { id: owner, outbox: `${owner}/outbox` } },
    fetchAP: async (url) => (url === `${owner}/outbox`
      ? outboxDoc(owner, [{ id: `${owner}/notes/1`, type: 'Note', content: 'spoofed', attributedTo: 'https://evil.example/u/mallory' }])
      : null),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 0, 'attribution mismatch is refused, not ingested as the outbox owner');
});

test('follows the outbox\'s `first` page when items are not on the root', async () => {
  const owner = 'https://remote.example/u/alice';
  const store = fakeStore({ feeds: [{ accounts: ['alice@remote.example'], excludeAccounts: [] }] });
  const sources = build({
    store,
    resolved: { 'alice@remote.example': { id: owner, outbox: `${owner}/outbox` } },
    fetchAP: async (url) => {
      if (url === `${owner}/outbox`) return { id: url, type: 'OrderedCollection', first: `${owner}/outbox?page=1` };
      if (url === `${owner}/outbox?page=1`) return outboxDoc(owner, [note(owner, 1)]);
      return null;
    },
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1);
});

test('a host that refuses is backed off and not asked again this sweep', async () => {
  const store = fakeStore({
    feeds: [{
      accounts: ['alice@down.example', 'bob@down.example'], excludeAccounts: [],
    }],
  });
  let calls = 0;
  const sources = build({
    store,
    resolved: {
      'alice@down.example': { id: 'https://down.example/u/alice', outbox: 'https://down.example/u/alice/outbox' },
      'bob@down.example': { id: 'https://down.example/u/bob', outbox: 'https://down.example/u/bob/outbox' },
    },
    fetchAP: async () => { calls++; throw new Error('connection refused'); },
  });
  await sources.sweep();
  // Both accounts share a host: the first outbox fetch fails and backs the
  // host off, so the second account's outbox is never even requested.
  assert.equal(calls, 1);
});

test('backfills existing posts for a hashtag a custom feed names, reverse-chronologically', async () => {
  const owner = 'https://remote.example/u/alice';
  const noteId = `${owner}/notes/1`;
  const store = fakeStore({ feeds: [{ hashtags: ['hiking'] }] });
  const sources = build({
    store,
    fetcher: async (url) => {
      if (String(url).includes('/timelines/tag/hiking')) return jsonResponse(200, [{ uri: noteId }]);
      throw new Error(`unexpected fetch ${url}`);
    },
    fetchAP: async (url) => (url === noteId ? { id: noteId, type: 'Note', content: 'hi', attributedTo: owner } : null),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1);
  assert.equal(store.getStatuses()[0].kind, 'tag');
  assert.equal(sources.lastBackfilled, 1);
});

test('a backfill host that refuses does not throw and backs off, adding nothing', async () => {
  const store = fakeStore({ feeds: [{ hashtags: ['hiking'] }] });
  const sources = build({
    store,
    fetcher: async () => { throw new Error('connection refused'); },
    fetchAP: async () => { throw new Error('should never be called'); },
  });
  await assert.doesNotReject(() => sources.sweep());
  assert.equal(store.getStatuses().length, 0);
  assert.equal(sources.lastBackfilled, 0);
});

test('a backfill candidate already known locally is not re-ingested', async () => {
  const owner = 'https://remote.example/u/alice';
  const noteId = `${owner}/notes/1`;
  const store = fakeStore({ feeds: [{ hashtags: ['hiking'] }] });
  store.addStatus({ noteId, actor: owner, content: 'hi', kind: 'tag' });
  const sources = build({
    store,
    fetcher: async (url) => (String(url).includes('/timelines/tag/hiking') ? jsonResponse(200, [{ uri: noteId }]) : jsonResponse(404, [])),
    fetchAP: async () => { throw new Error('should never be called — already known, never dereferenced'); },
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1, 'the pre-seeded note is not duplicated');
  assert.equal(sources.lastBackfilled, 0);
});

test('a backfill candidate the outbox owner does not actually attribute to itself is refused', async () => {
  const owner = 'https://remote.example/u/alice';
  const noteId = `${owner}/notes/1`;
  const store = fakeStore({ feeds: [{ hashtags: ['hiking'] }] });
  const sources = build({
    store,
    fetcher: async (url) => (String(url).includes('/timelines/tag/hiking') ? jsonResponse(200, [{ uri: noteId }]) : jsonResponse(404, [])),
    fetchAP: async (url) => (url === noteId ? { id: 'https://different.example/notes/1', type: 'Note', content: 'spoofed' } : null),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 0, 'a note that does not vouch for its own uri is refused');
});

test('one backfill instance refusing falls through to the next candidate', async () => {
  const owner = 'https://remote.example/u/alice';
  const noteId = `${owner}/notes/1`;
  const store = fakeStore({ feeds: [{ hashtags: ['hiking'] }] });
  const tried = [];
  const sources = build({
    store,
    fetcher: async (url) => {
      tried.push(url);
      if (String(url).includes('mastodon.social')) return jsonResponse(403, []);
      if (String(url).includes('mastodon.world')) return jsonResponse(200, [{ uri: noteId }]);
      throw new Error(`unexpected fetch ${url}`);
    },
    fetchAP: async (url) => (url === noteId ? { id: noteId, type: 'Note', content: 'hi', attributedTo: owner } : null),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1);
  assert.ok(tried.some((u) => u.includes('mastodon.social')), 'the first candidate was tried');
  assert.ok(tried.some((u) => u.includes('mastodon.world')), 'the second candidate was tried after the first refused');
});

test('a feed with no hashtags never touches the backfill host', async () => {
  const owner = 'https://remote.example/u/alice';
  const store = fakeStore({ feeds: [{ accounts: ['alice@remote.example'], excludeAccounts: [] }] });
  const sources = build({
    store,
    resolved: { 'alice@remote.example': { id: owner, outbox: `${owner}/outbox` } },
    fetcher: async () => { throw new Error('should never be called — no hashtags to back-fill'); },
    fetchAP: async (url) => (url === `${owner}/outbox` ? outboxDoc(owner, []) : null),
  });
  await sources.sweep();
  assert.equal(sources.lastBackfilled, 0);
});

test('an already-known note is not re-ingested', async () => {
  const owner = 'https://remote.example/u/alice';
  const store = fakeStore({ feeds: [{ accounts: ['alice@remote.example'], excludeAccounts: [] }] });
  store.addStatus({ noteId: `${owner}/notes/1`, actor: owner, content: 'hi', kind: 'tag' });
  const sources = build({
    store,
    resolved: { 'alice@remote.example': { id: owner, outbox: `${owner}/outbox` } },
    fetchAP: async (url) => (url === `${owner}/outbox` ? outboxDoc(owner, [note(owner, 1)]) : null),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1, 'the pre-seeded note is not duplicated');
});

test('semantic backfill matches by embedding when a provider is configured', async () => {
  const owner = 'https://remote.example/u/alice';
  const hit = `${owner}/notes/hit`;
  const miss = `${owner}/notes/miss`;
  const store = fakeStore({ feeds: [{ semanticKeywords: ['trail running gear'] }] });
  const embedCalls = [];
  const sources = build({
    store,
    fetcher: async (url) => (String(url).includes('/timelines/public')
      ? jsonResponse(200, [{ uri: hit, content: 'my new trail shoes' }, { uri: miss, content: 'lasagna recipe' }])
      : jsonResponse(404, [])),
    fetchAP: async (url) => (url === hit
      ? { id: hit, type: 'Note', content: 'my new trail shoes', attributedTo: owner } : null),
    aiBackendFor: () => ({
      provider: 'openai', apiKey: 'sk-test', backend: {
        matchByEmbedding: async ({ queries, documents }) => {
          embedCalls.push({ queries, documents });
          // Pretend only the "hit" document scores above threshold.
          return documents.filter((d) => d.id === hit).map((d) => ({ queryId: queries[0].id, documentId: d.id, score: 0.9 }));
        },
      },
    }),
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1);
  assert.equal(store.getStatuses()[0].noteId, hit);
  assert.equal(sources.lastSemanticBackfilled, 1);
  assert.equal(embedCalls.length, 1, 'the embedding call is made exactly once per sweep, not once per candidate');
});

test('semantic backfill falls back to a literal-phrase match with no AI provider configured', async () => {
  const owner = 'https://remote.example/u/alice';
  const hit = `${owner}/notes/hit`;
  const miss = `${owner}/notes/miss`;
  const store = fakeStore({ feeds: [{ semanticKeywords: ['trail running'] }] });
  const sources = build({
    store,
    fetcher: async (url) => (String(url).includes('/timelines/public')
      ? jsonResponse(200, [{ uri: hit, content: 'great TRAIL RUNNING today' }, { uri: miss, content: 'lasagna recipe' }])
      : jsonResponse(404, [])),
    fetchAP: async (url) => (url === hit
      ? { id: hit, type: 'Note', content: 'great TRAIL RUNNING today', attributedTo: owner } : null),
    // default aiBackendFor: no provider configured
  });
  await sources.sweep();
  assert.equal(store.getStatuses().length, 1);
  assert.equal(store.getStatuses()[0].noteId, hit, 'matched case-insensitively on the literal phrase');
});

test('semantic backfill falls back to literal matching when the embedding call itself fails', async () => {
  const owner = 'https://remote.example/u/alice';
  const hit = `${owner}/notes/hit`;
  const store = fakeStore({ feeds: [{ semanticKeywords: ['trail running'] }] });
  const sources = build({
    store,
    fetcher: async (url) => (String(url).includes('/timelines/public')
      ? jsonResponse(200, [{ uri: hit, content: 'trail running today' }])
      : jsonResponse(404, [])),
    fetchAP: async (url) => (url === hit ? { id: hit, type: 'Note', content: 'trail running today', attributedTo: owner } : null),
    aiBackendFor: () => ({
      provider: 'openai', apiKey: 'sk-test',
      backend: { matchByEmbedding: async () => { throw new Error('rate limited'); } },
    }),
  });
  await assert.doesNotReject(() => sources.sweep());
  assert.equal(store.getStatuses().length, 1, 'the embedding failure did not block the literal fallback');
});

test('a feed with no semantic keywords never touches the public-timeline host', async () => {
  const store = fakeStore({ feeds: [{ hashtags: [] }] });
  const sources = build({
    store,
    fetcher: async () => { throw new Error('should never be called — no semantic keywords to back-fill'); },
    fetchAP: async () => null,
  });
  await sources.sweep();
  assert.equal(sources.lastSemanticBackfilled, 0);
});
