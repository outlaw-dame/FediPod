import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePublicStatus, PublicFeed, SseDecoder } from '../../lib/publicfeed.mjs';

const now = new Date().toISOString();
const status = {
  uri: 'https://social.example/users/ada/statuses/1',
  created_at: now,
  visibility: 'public',
  content: '<p>Hello <script>bad()</script><a href="javascript:bad()">link</a></p>',
  account: {
    uri: 'https://social.example/users/ada', username: 'ada', display_name: '<b>Ada</b>',
    note: '<p>Builder</p>', avatar: 'javascript:bad()', header: 'https://cdn.example/h.png',
  },
  media_attachments: [{ type: 'image', remote_url: 'https://cdn.example/a.png', description: 'alt' }],
};

test('normalizes only current public same-origin statuses and sanitizes remote fields', () => {
  const out = normalizePublicStatus(status, 'relay');
  assert.equal(out.status.kind, 'public-feed');
  assert.equal(out.status.source, 'relay');
  assert.equal(out.status.content, '<p>Hello <a rel="nofollow noopener noreferrer">link</a></p>');
  assert.equal(out.actor.icon, null);
  assert.equal(out.actor.image, 'https://cdn.example/h.png');
  assert.equal(out.status.attachments[0].url, 'https://cdn.example/a.png');
  assert.equal(normalizePublicStatus({ ...status, visibility: 'private' }), null);
  assert.equal(normalizePublicStatus({ ...status, in_reply_to_id: '2' }), null);
  assert.equal(normalizePublicStatus({ ...status, reblog: {} }), null);
  assert.equal(normalizePublicStatus({
    ...status, account: { ...status.account, uri: 'https://attacker.example/users/eve' },
  }), null);
});

test('queues, deduplicates, and stores a sanitized public cache entry', () => {
  const statuses = [];
  const actors = {};
  const store = {
    read: (_name, fallback) => fallback,
    isBlocked: () => false,
    getStatuses: () => structuredClone(statuses),
    removeStatus: (id) => { const at = statuses.findIndex(s => s.noteId === id); if (at >= 0) statuses.splice(at, 1); },
    cacheActor: (id, actor) => { actors[id] = actor; },
    addStatus: (item) => { if (!statuses.some(s => s.noteId === item.noteId)) statuses.unshift(item); },
  };
  const feed = new PublicFeed({ store, log: () => {} });
  assert.equal(feed.enqueue(status, 'test.instance'), true);
  assert.equal(feed.enqueue(status, 'test.instance'), false);
  feed._drainOne();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].kind, 'public-feed');
  assert.equal(actors['https://social.example/users/ada'].preferredUsername, 'ada');
});

test('decodes SSE events split across chunks', () => {
  const got = [];
  const decoder = new SseDecoder((event, data) => got.push({ event, data }));
  decoder.push(': heartbeat\n\nevent: up');
  decoder.push('date\ndata: {"id":');
  decoder.push('"1"}\n\n');
  assert.deepEqual(got, [{ event: 'update', data: '{"id":"1"}' }]);
});
