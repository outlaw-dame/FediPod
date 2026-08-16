// relay-tags.mjs — keeps this agent's follows of fedi.buzz's per-hashtag
// relay actors (https://github.com/astro/buzzrelay, hosted at
// relay.fedi.buzz — the same fedi.buzz project lib/publicfeed.mjs already
// streams from) in sync with the hashtags actually used across custom
// feeds. Each relay actor (https://relay.fedi.buzz/tag/<hashtag>) is a
// normal ActivityPub Service: following it is an ordinary Follow, and it
// Announces every public post it sees under that hashtag from across the
// fediverse into the normal inbox — no separate polling/ingestion path
// needed, unlike lib/custom-feed-sources.mjs's per-account outbox sweep.
//
// Announced posts land in the store exactly like any other followed
// account's post, which means they show up in the home timeline too, not
// just in the custom feed(s) that named the hashtag — matching the
// existing precedent of lib/tagfeed.mjs's and lib/publicfeed.mjs's content,
// neither of which /api/v1/timelines/home filters out either.
//
// This is reconciliation, not a sweep of its own: no polling loop — just
// "make the follow set match what custom feeds currently need." Call it
// after every custom-feed create/update/delete, and it also rides along on
// lib/custom-feed-sources.mjs's periodic tick as a safety net for a Follow
// that failed to deliver the first time.
//
// Followed hidden (social.mjs's followActor({hidden:true})): the owner
// didn't consciously choose to follow "#hiking" as a social act, a custom
// feed just needs its posts, so the relay actor is excluded everywhere the
// following list is actually a social graph — the published AP following
// collection and the Mastodon API following count/list — while still
// being a real, working Follow underneath (Accept/Announce/Undo all
// function exactly as normal; intake.mjs's trust checks don't distinguish
// hidden from ordinary follows, which is what lets the relay's Announces
// through at all).

import { followActor as realFollowActor, unfollowActor as realUnfollowActor } from './social.mjs';

const RELAY_HOST = 'relay.fedi.buzz';
const relayActorUrl = (tag) => `https://${RELAY_HOST}/tag/${encodeURIComponent(tag)}`;

function tagFromRelayActor(actorUrl) {
  try {
    const url = new URL(actorUrl);
    if (url.host !== RELAY_HOST) return null;
    const match = /^\/tag\/([^/]+)$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

// Exported for lib/custom-feed-sources.mjs's reverse-chronological backfill,
// which needs the exact same "what hashtags does any custom feed currently
// name" set this module already computes for the Follow side.
export function customFeedHashtags(store) {
  const tags = new Set();
  for (const feed of store.getCustomFeeds()) for (const tag of feed.hashtags || []) tags.add(tag);
  return tags;
}

/** Relay actors currently followed, keyed by the hashtag they carry. */
function currentRelayFollows(store) {
  const map = new Map();
  for (const rec of store.getContacts().following) {
    const tag = tagFromRelayActor(rec.actor);
    if (tag) map.set(tag, rec.actor);
  }
  return map;
}

// One-time self-heal for relay follows made before hidden existed (or by
// any other path that bypassed followActor's {hidden:true}): a relay
// actor's own URL shape identifies it regardless of how it got into
// contacts.following, so this needs no separate record of "which follows
// this module made." Republishes the following collection once, not once
// per record, if anything actually changed — otherwise this runs every
// sweep for nothing.
async function backfillHidden(agent, log) {
  const contacts = agent.store.getContacts();
  let changed = false;
  for (const rec of contacts.following) {
    if (tagFromRelayActor(rec.actor) && !rec.hidden) {
      rec.hidden = true;
      changed = true;
    }
  }
  if (!changed) return;
  agent.store.setContacts(contacts);
  try { await agent.publisher.publishCollections({ following: true }); }
  catch (e) { log(`relay-tags: could not republish following after hiding relay follows: ${e.message}`); }
  log('relay-tags: hid pre-existing relay follows from the public following list');
}

/**
 * Follows the relay actor for every hashtag a custom feed names that isn't
 * already followed, and unfollows any relay actor whose hashtag no custom
 * feed uses any more. Best-effort per hashtag — one relay Follow/Undo
 * failing (a network blip, the relay refusing) does not stop the rest from
 * reconciling.
 */
export async function syncRelayTagFollows(agent, log = console.log,
  { followActor = realFollowActor, unfollowActor = realUnfollowActor } = {}) {
  await backfillHidden(agent, log);
  const wanted = customFeedHashtags(agent.store);
  const following = currentRelayFollows(agent.store);
  for (const tag of wanted) {
    if (following.has(tag)) continue;
    try {
      await followActor(agent, relayActorUrl(tag), { hidden: true });
      log(`relay-tags: following #${tag} via fedi.buzz relay`);
    } catch (e) { log(`relay-tags: could not follow #${tag}: ${e.message}`); }
  }
  for (const [tag, actor] of following) {
    if (wanted.has(tag)) continue;
    try {
      await unfollowActor(agent, actor);
      log(`relay-tags: unfollowed #${tag} — no custom feed uses it any more`);
    } catch (e) { log(`relay-tags: could not unfollow #${tag}: ${e.message}`); }
  }
}
