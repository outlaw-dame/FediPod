import assert from 'node:assert/strict';
import test from 'node:test';

import { PodStore } from './store.mjs';

// Pure-memory PodStore (no `storage`) — the mode the class's own comment
// documents as safe for tests: writes just update the cache, nothing hits
// a network or disk.
function store() {
  return new PodStore({ log: () => {} });
}

test('recordModerationEvent + getModerationStats count events within the window', () => {
  const s = store();
  s.recordModerationEvent('blocked-actor');
  s.recordModerationEvent('blocked-actor');
  s.recordModerationEvent('blocked-domain');
  assert.deepEqual(s.getModerationStats(7), { blockedActor: 2, blockedDomain: 1 });
});

test('getModerationStats ignores events older than the requested window', () => {
  const s = store();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  s.write('moderation-events.json', [
    { ts: now - 10 * DAY, kind: 'blocked-actor' },   // outside a 7-day window
    { ts: now - 2 * DAY, kind: 'blocked-actor' },    // inside
    { ts: now - 1 * DAY, kind: 'blocked-domain' },   // inside
  ]);
  assert.deepEqual(s.getModerationStats(7), { blockedActor: 1, blockedDomain: 1 });
  assert.deepEqual(s.getModerationStats(30), { blockedActor: 2, blockedDomain: 1 });
});

test('recordModerationEvent prunes entries past 30 days on every write', () => {
  const s = store();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  s.write('moderation-events.json', [
    { ts: now - 40 * DAY, kind: 'blocked-actor' },
    { ts: now - 29 * DAY, kind: 'blocked-actor' },
  ]);
  s.recordModerationEvent('blocked-domain');
  const events = s.read('moderation-events.json', []);
  assert.equal(events.length, 2, 'the 40-day-old entry is dropped, the 29-day-old and new one survive');
  assert.equal(events.filter((e) => e.kind === 'blocked-actor').length, 1);
  assert.equal(events.filter((e) => e.kind === 'blocked-domain').length, 1);
});

test('recordModerationEvent caps the log at 5,000 entries', () => {
  const s = store();
  const now = Date.now();
  s.write('moderation-events.json', Array.from({ length: 5_000 }, (_, i) => ({ ts: now, kind: 'blocked-actor' })));
  s.recordModerationEvent('blocked-domain');
  const events = s.read('moderation-events.json', []);
  assert.equal(events.length, 5_000);
  assert.equal(events.at(-1).kind, 'blocked-domain', 'the newest event is kept, not dropped by the cap');
});
