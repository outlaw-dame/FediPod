// custom-feed-sources.mjs — active ingestion for custom-feed accounts and
// hashtags, plus the periodic safety net for lib/relay-tags.mjs's hashtag
// follows.
//
// A custom feed's `accounts` field explicitly does not follow (see
// custom-feeds.mjs / the Ailo UI copy: "This does not follow them") — the
// account list is a filter, not a subscription. But without SOME source,
// an account nobody follows never has a single post in this store to
// filter *in*: /api/v1/ailo/custom-feeds/:id/timeline only ever answers
// from this.store.getStatuses(), which normally fills from inbox delivery
// (followed accounts, including fedi.buzz's per-hashtag relay actors) —
// nothing covers a named-but-unfollowed ACCOUNT. A feed built entirely from
// such accounts would silently show nothing to match against, forever.
//
// This periodically fetches each such account's public outbox (recent
// items only) and mirrors new Notes in, the same "view cache only, verify
// by dereference" shape lib/tagfeed.mjs uses for its own configured
// hashtags — not written to the pod, not a follow, just something for the
// local filter to run against. Politeness matches tagfeed.mjs too: a
// budget per sweep, and backoff on refusal — per REMOTE HOST here rather
// than a single instance, since custom-feed accounts are scattered across
// arbitrary servers.
//
// A hashtag-based feed has the same cold-start gap for a different reason:
// relay-tags.mjs's Follow of relay.fedi.buzz's tag actor only carries posts
// FORWARD from the moment it's accepted — the relay actor's own outbox is a
// permanent empty stub (confirmed by hand against the live relay), so there
// is no historical Announce replay to lean on. A feed built from a hashtag
// just added shows nothing until the fediverse happens to post something
// new under that tag. _tagBackfill closes that gap by polling a public
// hashtag timeline — reverse-chronological, so it's existing content, not
// just new — the same "verify by dereference at the note's own origin"
// shape lib/tagfeed.mjs already uses for its own configured tags.
//
// Queried against publicfeed.mjs's DEFAULT_INSTANCES, not fedi.buzz itself:
// confirmed by hand that fedi.buzz's nginx answers this agent's own
// (honestly self-identifying) user-agent with a blanket 403 on
// /api/v1/timelines/tag/* specifically — the literal substring "FediPod",
// deliberately, since e.g. "fedipod/0.5" passes and "FediPod" alone does
// not. Their public SSE stream (what publicfeed.mjs already consumes) has
// no such block, so that path is untouched — but sending a different UA
// just for this one call to route around a host's own targeted block on
// this client would be evading a decision they made about us on purpose,
// not fixing a bug. Polling several ordinary well-connected instances'
// LOCAL tag timelines instead is less complete than one global relay would
// have been, but it is honest, and several general-audience instances
// together still surface a reasonable cross-section to seed a new feed.

import { authorOf, isContentType } from './intake.mjs';
import { resolveHandle as realResolveHandle } from './social.mjs';
import { syncRelayTagFollows, customFeedHashtags } from './relay-tags.mjs';
import { safeFetch } from './safefetch.mjs';
import { DEFAULT_INSTANCES as BACKFILL_INSTANCES } from './publicfeed.mjs';

const SWEEP_INTERVAL_MIN = 15;
const MAX_NEW_PER_ACCOUNT = 8;     // outbox items dereferenced per account per sweep
const MAX_NEW_PER_SWEEP = 20;      // total dereference budget per sweep — stay light
const MAX_ENTRIES = 300;           // oldest swept entries pruned beyond this
const BACKOFF_MIN_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
const RESOLVE_TTL_MS = 6 * 60 * 60_000;   // re-resolve a handle at most this often

const PER_TAG_BACKFILL = 20;       // statuses requested per hashtag per sweep
const MAX_BACKFILL_PER_SWEEP = 12; // dereference budget per sweep — stay light, own pool from the account sweep's

// Mirrors mastoapi.mjs's account()'s acct formula (preferredUsername, or
// the URL's last path segment, @ the actor's own host) — the one place that
// needs it here doesn't have a MastoApi instance to borrow the real one from.
function acctFor(store, actorUrl) {
  const cached = store.getActors()[actorUrl] || {};
  let host = '';
  let user = cached.preferredUsername || '';
  try {
    host = new URL(actorUrl).host;
    if (!user) user = new URL(actorUrl).pathname.split('/').pop();
  } catch { /* unparsable actor URL — acct comes back host-less, never matches a feed rule */ }
  return `${user}@${host}`.toLowerCase();
}

export class CustomFeedSources {
  constructor({
    store, intake, agent, log = console.log,
    resolveHandle = realResolveHandle, fetcher = globalThis.fetch,
  }) {
    Object.assign(this, { store, intake, agent, log, resolveHandle, fetcher });
    this.hostBackoff = new Map();     // host -> quietUntil ms
    this.hostFailures = new Map();    // host -> consecutive refusal count
    this.resolved = new Map();        // handle -> { doc, at }
    this.lastSweep = null;
    this.lastAdded = 0;
    this.lastBackfilled = 0;
  }

  // Accounts named by any custom feed that aren't already followed —
  // a followed account's posts already arrive normally, sweeping those too
  // would just be redundant load against someone else's server.
  accountsToSweep() {
    const feeds = this.store.getCustomFeeds();
    const named = new Set();
    for (const feed of feeds) for (const account of feed.accounts || []) named.add(account);
    if (!named.size) return [];
    const following = new Set(
      this.store.getContacts().following
        .filter((f) => f.accepted)
        .map((f) => acctFor(this.store, f.actor)),
    );
    return [...named].filter((acct) => !following.has(acct));
  }

  start() {
    this.stopped = false;
    this.sweep().catch((e) => this.log(`custom-feed-sources: ${e.message}`));
    // Jittered and self-scheduling, same reasoning as tagfeed.mjs: every
    // agent sweeping on the same 15-minute boundary is a beat nobody asked for.
    const tick = () => {
      this.timer = setTimeout(() => {
        this.sweep()
          .catch((e) => this.log(`custom-feed-sources: ${e.message}`))
          .finally(() => { if (!this.stopped) tick(); });
      }, Math.round(SWEEP_INTERVAL_MIN * 60_000 * (0.85 + Math.random() * 0.3)));
      this.timer.unref?.();
    };
    tick();
  }

  // Same shape as tagfeed.mjs's stop(): the flag is what makes it stick — a
  // sweep already in flight re-arms itself in `finally`, so only `stopped`
  // (read there) actually prevents the next tick from being scheduled.
  stop() { this.stopped = true; clearTimeout(this.timer); }

  _hostQuiet(host) {
    const until = this.hostBackoff.get(host);
    return !!until && Date.now() < until;
  }

  _backOff(host) {
    const failures = (this.hostFailures.get(host) || 0) + 1;
    this.hostFailures.set(host, failures);
    const ladder = Math.min(BACKOFF_MIN_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    const wait = Math.round(ladder * (0.85 + Math.random() * 0.3));
    this.hostBackoff.set(host, Date.now() + wait);
    this.log(`custom-feed-sources: ${host} did not answer — not asking again for ${Math.round(wait / 60_000)} min`);
  }

  // resolveHandle does a WebFinger round trip plus an actor fetch on every
  // call — worth remembering across sweeps for the same handle rather than
  // repeating both on every tick.
  async _resolve(acct) {
    const cached = this.resolved.get(acct);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.doc;
    const doc = await this.resolveHandle(this.agent, acct);
    this.resolved.set(acct, { doc, at: Date.now() });
    return doc;
  }

  // The outbox root is often a bare OrderedCollection naming `first`, with
  // the actual items on that first page (Mastodon's shape); some servers
  // put orderedItems directly on the root instead. Either is accepted.
  async _outboxPage(outbox) {
    let page = await this.intake.fetchAP(outbox);
    let items = page?.orderedItems || page?.items;
    if (!items && page?.first) {
      const firstUrl = typeof page.first === 'string' ? page.first : page.first?.id;
      if (firstUrl) {
        page = await this.intake.fetchAP(firstUrl);
        items = page?.orderedItems || page?.items;
      }
    }
    return Array.isArray(items) ? items : [];
  }

  // Reverse-chronological top-up for hashtag-based custom feeds — see the
  // header comment for why relay-tags.mjs's Follow alone leaves a feed
  // empty until new content happens to arrive. `known` and `budget` are
  // shared with the caller so accounts and hashtags draw from one dereference
  // pool per sweep rather than each getting their own, and so a tag and an
  // account sweep in the same tick never double-ingest the same note.
  async _tagBackfill(known, budget) {
    const tags = customFeedHashtags(this.store);
    let added = 0;
    if (!tags.size) return { added, budget };
    for (const tag of tags) {
      if (budget <= 0) break;
      // Try each candidate instance in turn until one actually answers —
      // any ONE of them having this tag's local timeline is enough to seed
      // the feed, and a host already backing off from an earlier tag this
      // sweep is skipped rather than asked again.
      let list = null;
      for (const instance of BACKFILL_INSTANCES) {
        const host = new URL(instance).host;
        if (this._hostQuiet(host)) continue;
        try {
          const url = `${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${PER_TAG_BACKFILL}`;
          const res = this.fetcher === globalThis.fetch
            ? await safeFetch(url, { headers: { accept: 'application/json' } })
            : await this.fetcher(url, { headers: { accept: 'application/json' } });
          if (res.status >= 400) { this._backOff(host); continue; }
          list = await res.json();
          this.hostFailures.delete(host);
          break;
        } catch (e) {
          this.log(`custom-feed-sources tag-backfill #${tag} via ${host}: ${e.message}`);
          this._backOff(host);
        }
      }
      if (!Array.isArray(list)) continue;   // every candidate refused or is already backing off
      for (const st of list) {
        if (budget <= 0) break;
        const noteId = st?.uri;
        if (!noteId || known.has(noteId) || this.store.isBlocked(noteId)) continue;
        // Verified by dereference at the note's own origin — the timeline
        // JSON is only ever a pointer to go fetch the real thing, never
        // trusted as content on its own (same shape as tagfeed.mjs).
        const note = await this.intake.fetchAP(noteId).catch(() => null);
        if (!note || note.id !== noteId || !isContentType(note.type)) continue;
        const author = authorOf(note);
        if (!author || this.store.isBlocked(author)) continue;
        if (!this.store.getActors()[author]) await this.intake.fetchAP(author).catch(() => {});
        const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
        const attachments = attachmentsOf(note);
        this.store.addStatus({
          noteId, actor: author, content: sanitizeHtml(note.content),
          published: note.published, inReplyTo: note.inReplyTo, kind: 'tag', tag,
          ...(attachments.length ? { attachments } : {}),
        });
        known.add(noteId);
        added++;
        budget--;
      }
    }
    return { added, budget };
  }

  async sweep() {
    // Safety net for lib/relay-tags.mjs: a Follow that failed to deliver
    // when a feed was first saved (or last saved before this process
    // started) gets another attempt here, on the same cadence as the
    // account sweep below rather than a timer of its own.
    await syncRelayTagFollows(this.agent, this.log).catch((e) => this.log(`relay-tags: ${e.message}`));
    this.lastSweep = new Date().toISOString();
    const known = new Set(this.store.getStatuses().map((s) => s.noteId));

    const backfill = await this._tagBackfill(known, MAX_BACKFILL_PER_SWEEP)
      .catch((e) => { this.log(`custom-feed-sources tag-backfill: ${e.message}`); return { added: 0 }; });
    this.lastBackfilled = backfill.added;

    const accounts = this.accountsToSweep();
    let budget = MAX_NEW_PER_SWEEP;
    let added = backfill.added;
    for (const acct of accounts) {
      if (budget <= 0) break;
      const host = acct.split('@')[1]?.toLowerCase();
      if (!host || this._hostQuiet(host)) continue;

      let doc;
      try { doc = await this._resolve(acct); }
      catch (e) { this.log(`custom-feed-sources #${acct}: ${e.message}`); continue; }
      if (!doc.outbox) continue;

      let items;
      try { items = await this._outboxPage(doc.outbox); }
      catch (e) { this.log(`custom-feed-sources #${acct} outbox: ${e.message}`); this._backOff(host); continue; }
      this.hostFailures.delete(host);

      let perAccount = MAX_NEW_PER_ACCOUNT;
      for (const entry of items) {
        if (budget <= 0 || perAccount-- <= 0) break;
        // An outbox entry is usually an embedded Create{object: Note}, but
        // some servers list bare object/activity IDs instead — either way,
        // resolve down to the Note itself before anything is trusted.
        const activity = typeof entry === 'string' ? await this.intake.fetchAP(entry).catch(() => null) : entry;
        const noteRef = activity?.type === 'Create' ? activity.object : activity;
        const note = typeof noteRef === 'string' ? await this.intake.fetchAP(noteRef).catch(() => null) : noteRef;
        const noteId = note?.id;
        if (!noteId || known.has(noteId) || this.store.isBlocked(noteId) || !isContentType(note?.type)) continue;
        // Verified two ways: the note names an author its own origin
        // vouches for (authorOf), and that author is the account this
        // outbox actually belongs to — an outbox naming someone else's
        // Notes is not this account speaking for them.
        const author = authorOf(note);
        if (!author || author !== doc.id || this.store.isBlocked(author)) continue;
        const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
        this.store.addStatus({
          noteId, actor: author, content: sanitizeHtml(note.content),
          published: note.published, inReplyTo: note.inReplyTo, kind: 'tag',
          ...(attachmentsOf(note).length ? { attachments: attachmentsOf(note) } : {}),
        });
        known.add(noteId);
        added++;
        budget--;
      }
    }
    const all = this.store.getStatuses();
    const swept = all.filter((s) => s.kind === 'tag');
    if (swept.length > MAX_ENTRIES) {
      // Oldest-first pruning across BOTH sweepers' output (tagfeed.mjs
      // shares the 'tag' kind) — arrival order, so the tail is oldest,
      // same cap-and-trim shape tagfeed.mjs uses for its own entries.
      const drop = new Set(swept.slice(MAX_ENTRIES).map((s) => s.noteId));
      this.store.write('statuses.json', all.filter((s) => !drop.has(s.noteId)));
    }
    this.lastAdded = added;
    if (added) {
      const backfillNote = backfill.added ? ` (${backfill.added} backfilled)` : '';
      this.log(`custom-feed-sources: +${added}${backfillNote} from ${accounts.length} account(s)`);
    }
  }
}
