import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRelayTagFollows } from './relay-tags.mjs';

function fakeAgent({ feeds = [], following = [] } = {}) {
  let contacts = { followers: [], following };
  const republished = [];
  return {
    store: {
      getCustomFeeds: () => feeds,
      getContacts: () => contacts,
      setContacts: (next) => { contacts = next; },
    },
    publisher: { publishCollections: async (which) => { republished.push(which); } },
    _republished: republished,
  };
}

test('follows the relay actor for a hashtag no feed is followed for yet', async () => {
  const agent = fakeAgent({ feeds: [{ hashtags: ['hiking', 'trailrunning'] }] });
  const followed = [];
  await syncRelayTagFollows(agent, () => {}, {
    followActor: async (_agent, actorUrl) => followed.push(actorUrl),
    unfollowActor: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(followed.sort(), [
    'https://relay.fedi.buzz/tag/hiking',
    'https://relay.fedi.buzz/tag/trailrunning',
  ]);
});

test('does not re-follow a hashtag relay already followed', async () => {
  const agent = fakeAgent({
    feeds: [{ hashtags: ['hiking'] }],
    following: [{ actor: 'https://relay.fedi.buzz/tag/hiking', accepted: true, hidden: true }],
  });
  const followed = [];
  await syncRelayTagFollows(agent, () => {}, {
    followActor: async (_agent, actorUrl) => followed.push(actorUrl),
    unfollowActor: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(followed, []);
});

test('unfollows a relay hashtag no custom feed uses any more', async () => {
  const agent = fakeAgent({
    feeds: [],
    following: [
      { actor: 'https://relay.fedi.buzz/tag/oldtag', accepted: true, hidden: true },
      { actor: 'https://example.social/u/alice', accepted: true },
    ],
  });
  const unfollowed = [];
  await syncRelayTagFollows(agent, () => {}, {
    followActor: async () => { throw new Error('should not be called'); },
    unfollowActor: async (_agent, actor) => unfollowed.push(actor),
  });
  // A plain followed person is left alone — only the relay-tag actor is unfollowed.
  assert.deepEqual(unfollowed, ['https://relay.fedi.buzz/tag/oldtag']);
});

test('one hashtag failing to follow does not stop the rest from reconciling', async () => {
  const agent = fakeAgent({ feeds: [{ hashtags: ['ok', 'refused'] }] });
  const followed = [];
  const logs = [];
  await syncRelayTagFollows(agent, (msg) => logs.push(msg), {
    followActor: async (_agent, actorUrl) => {
      if (actorUrl.endsWith('/refused')) throw new Error('actor refused the follow');
      followed.push(actorUrl);
    },
    unfollowActor: async () => {},
  });
  assert.deepEqual(followed, ['https://relay.fedi.buzz/tag/ok']);
  assert.ok(logs.some((line) => line.includes('refused') && line.includes('could not follow')));
});

test('backfills hidden on a relay follow made before hidden existed, and republishes once', async () => {
  const agent = fakeAgent({
    feeds: [{ hashtags: ['hiking'] }],
    // No `hidden` flag — as every relay follow made before this existed looks.
    following: [{ actor: 'https://relay.fedi.buzz/tag/hiking', accepted: true }],
  });
  await syncRelayTagFollows(agent, () => {}, {
    followActor: async () => { throw new Error('should not re-follow — already following'); },
    unfollowActor: async () => { throw new Error('should not unfollow — the feed still uses it'); },
  });
  assert.equal(agent.store.getContacts().following[0].hidden, true);
  assert.deepEqual(agent._republished, [{ following: true }]);
});

test('a relay follow already hidden triggers no redundant republish', async () => {
  const agent = fakeAgent({
    feeds: [{ hashtags: ['hiking'] }],
    following: [{ actor: 'https://relay.fedi.buzz/tag/hiking', accepted: true, hidden: true }],
  });
  await syncRelayTagFollows(agent, () => {}, {
    followActor: async () => { throw new Error('should not be called'); },
    unfollowActor: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(agent._republished, []);
});
