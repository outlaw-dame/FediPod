// publicfeed.mjs — bounded public discovery intake for FediPod.
//
// The live source is FediBuzz's public Mastodon-compatible SSE stream. A small
// set of public instance timelines supplies startup/backfill coverage when the
// stream reconnects. This is a local view cache only: nothing is published,
// delivered, or written into the actor's ActivityPub outbox.

import { retryAfterMs, safeFetch } from './safefetch.mjs';
import { sanitizeHtml } from './wire.mjs';

export const DEFAULT_RELAY = 'https://fedi.buzz/api/v1/streaming/public';
export const DEFAULT_INSTANCES = [
  'https://mastodon.social',
  'https://mastodon.world',
  'https://flipboard.social',
  'https://indieweb.social',
  'https://social.wedistribute.org',
  'https://social.vivaldi.net',
  'https://mindly.social',
];

const MAX_PUBLIC_ENTRIES = 300;
const MAX_QUEUE = 60;
const INGEST_EVERY_MS = 1_500;
const POLL_EVERY_MS = 5 * 60_000;
const POLL_LIMIT = 6;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const SOURCE_BACKOFF_MIN_MS = 15 * 60_000;
const SOURCE_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const STREAM_IDLE_MS = 90_000;
const MAX_EVENT_BYTES = 1_000_000;

function httpsUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function mediaType(item) {
  if (item?.mime_type) return String(item.mime_type).split(';')[0].toLowerCase();
  const rawUrl = String(item?.remote_url || item?.url || '').split(/[?#]/)[0].toLowerCase();
  const inferred = [
    ['.webm', 'video/webm'], ['.ogv', 'video/ogg'], ['.mkv', 'video/x-matroska'],
    ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.gif', 'image/gif'],
  ].find(([extension]) => rawUrl.endsWith(extension));
  if (inferred) return inferred[1];
  if (item?.type === 'video' || item?.type === 'gifv') return 'video/mp4';
  if (item?.type === 'audio') return 'audio/mpeg';
  return 'image/jpeg';
}

/** Turn an untrusted Mastodon status into FediPod's narrow local cache shape. */
export function normalizePublicStatus(raw, source = 'public-feed') {
  if (!raw || typeof raw !== 'object' || raw.reblog) return null;
  if (raw.visibility !== 'public' || raw.local_only === true || raw.in_reply_to_id) return null;
  const noteId = httpsUrl(raw.uri || raw.ap_id);
  const actor = httpsUrl(raw.account?.uri);
  if (!noteId || !actor) return null;
  // The actor's own origin must vouch for the object. This drops proxy-shaped
  // or forged rows while allowing ordinary Mastodon, Misskey and bridged AP
  // objects whose actor and object live under the same authority.
  if (new URL(noteId).origin !== new URL(actor).origin) return null;
  const published = String(raw.created_at || '');
  const when = Date.parse(published);
  if (!Number.isFinite(when) || when > Date.now() + 10 * 60_000
    || when < Date.now() - 7 * 24 * 60 * 60_000) return null;

  const attachments = (Array.isArray(raw.media_attachments) ? raw.media_attachments : [])
    .slice(0, 4).map((item) => {
      const url = httpsUrl(item?.remote_url || item?.url);
      return url ? {
        url,
        mediaType: mediaType(item),
        ...(httpsUrl(item?.preview_url) ? { previewUrl: httpsUrl(item.preview_url) } : {}),
        ...(typeof item?.description === 'string' ? { description: item.description.slice(0, 2_000) } : {}),
      } : null;
    }).filter(Boolean);
  const mentions = (Array.isArray(raw.mentions) ? raw.mentions : []).slice(0, 50)
    .map((item) => {
      const href = httpsUrl(item?.url);
      const name = typeof item?.acct === 'string' ? item.acct : item?.username;
      return href && name ? { href, name: String(name).slice(0, 500) } : null;
    }).filter(Boolean);
  const username = String(raw.account?.username || raw.account?.acct || '').split('@')[0].slice(0, 500);
  if (!username) return null;

  return {
    status: {
      noteId,
      actor,
      content: sanitizeHtml(raw.content || ''),
      published: new Date(when).toISOString(),
      kind: 'public-feed',
      source,
      ...(/^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(String(raw.language || ''))
        ? { language: String(raw.language) } : {}),
      ...(raw.sensitive || raw.spoiler_text ? { spoiler: String(raw.spoiler_text || 'Sensitive content').slice(0, 5_000) } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(mentions.length ? { mentions } : {}),
    },
    actor: {
      preferredUsername: username,
      name: raw.account?.display_name || username,
      summary: raw.account?.note || '',
      icon: httpsUrl(raw.account?.avatar_static || raw.account?.avatar),
      image: httpsUrl(raw.account?.header_static || raw.account?.header),
      type: raw.account?.group ? 'Group' : 'Person',
    },
  };
}

/** Incremental SSE decoder; event payloads may be split across TCP chunks. */
export class SseDecoder {
  constructor(onEvent) { this.onEvent = onEvent; this.buffer = ''; }

  push(chunk) {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    if (this.buffer.length > MAX_EVENT_BYTES) this.buffer = this.buffer.slice(-MAX_EVENT_BYTES);
    let split;
    while ((split = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) this.onEvent(event, data.join('\n'));
    }
  }
}

export class PublicFeed {
  constructor({ store, log = console.log, fetcher = globalThis.fetch, pollFetcher = safeFetch } = {}) {
    Object.assign(this, { store, log, fetcher, pollFetcher });
    this.queue = [];
    this.queued = new Set();
    this.sourceState = new Map();
    this.received = 0;
    this.added = 0;
    this.lastEvent = null;
    this.reconnects = 0;
  }

  config() {
    return {
      enabled: true,
      relay: DEFAULT_RELAY,
      instances: DEFAULT_INSTANCES,
      ...(this.store.read('publicfeed.json', {})),
    };
  }

  status() {
    const cfg = this.config();
    return {
      enabled: cfg.enabled !== false,
      relay: cfg.relay,
      instances: cfg.instances,
      connected: !!this.connected,
      queued: this.queue.length,
      received: this.received,
      added: this.added,
      lastEvent: this.lastEvent,
      lastPoll: this.lastPoll || null,
      reconnects: this.reconnects,
    };
  }

  start() {
    if (this.running || this.config().enabled === false) return;
    this.running = true;
    this.stopped = false;
    this.ingestTimer = setInterval(() => this._drainOne(), INGEST_EVERY_MS);
    this.ingestTimer.unref?.();
    this._pollAll().catch(e => this.log(`publicfeed poll: ${e.message}`));
    const pollTick = () => {
      this.pollTimer = setTimeout(() => {
        this._pollAll().catch(e => this.log(`publicfeed poll: ${e.message}`))
          .finally(() => { if (!this.stopped) pollTick(); });
      }, Math.round(POLL_EVERY_MS * (0.85 + Math.random() * 0.3)));
      this.pollTimer.unref?.();
    };
    pollTick();
    this._streamLoop().catch(e => this.log(`publicfeed stream: ${e.message}`));
  }

  stop() {
    this.stopped = true;
    this.running = false;
    this.connected = false;
    clearInterval(this.ingestTimer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.waitTimer);
    this.abort?.abort();
    this.waitResolve?.();
    this.waitResolve = null;
  }

  enqueue(raw, source) {
    const normalized = normalizePublicStatus(raw, source);
    if (!normalized) return false;
    const { noteId, actor } = normalized.status;
    if (this.store.isBlocked(noteId) || this.store.isBlocked(actor)
      || this.queued.has(noteId) || this.store.getStatuses().some(s => s.noteId === noteId)) return false;
    if (this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      if (dropped) this.queued.delete(dropped.status.noteId);
    }
    this.queue.push(normalized);
    this.queued.add(noteId);
    this.received++;
    this.lastEvent = new Date().toISOString();
    return true;
  }

  _drainOne() {
    if (this.stopped) return;
    const item = this.queue.shift();
    if (!item) return;
    this.queued.delete(item.status.noteId);
    if (this.store.isBlocked(item.status.noteId) || this.store.isBlocked(item.status.actor)) return;
    const all = this.store.getStatuses();
    if (all.some(s => s.noteId === item.status.noteId)) return;
    const publicRows = all.filter(s => s.kind === 'public-feed');
    if (publicRows.length >= MAX_PUBLIC_ENTRIES) {
      this.store.removeStatus(publicRows[publicRows.length - 1].noteId);
    }
    this.store.cacheActor(item.status.actor, item.actor);
    this.store.addStatus(item.status);
    this.added++;
  }

  async _streamLoop() {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this._consumeStream();
        failures = 0;
      } catch (e) {
        if (!this.stopped) this.log(`publicfeed relay: ${e.message}`);
        failures++;
      }
      if (this.stopped) break;
      this.reconnects++;
      const base = Math.min(RECONNECT_MIN_MS * 2 ** Math.min(failures, 8), RECONNECT_MAX_MS);
      await this._wait(Math.round(base * (0.8 + Math.random() * 0.4)));
    }
  }

  async _consumeStream() {
    const relay = this.config().relay;
    if (relay !== DEFAULT_RELAY) throw new Error('unsupported relay URL');
    this.abort = new AbortController();
    const response = await this.fetcher(relay, {
      headers: { accept: 'text/event-stream', 'user-agent': 'fedipod/0.5 public-discovery' },
      signal: this.abort.signal,
    });
    if (!response.ok || !String(response.headers.get('content-type') || '').includes('text/event-stream')) {
      throw new Error(`stream answered ${response.status}, not event-stream`);
    }
    if (!response.body) throw new Error('stream returned no body');
    this.connected = true;
    const resetIdle = () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.abort?.abort(new Error('stream idle timeout')), STREAM_IDLE_MS);
      this.idleTimer.unref?.();
    };
    resetIdle();
    const decoder = new TextDecoder();
    const sse = new SseDecoder((event, data) => {
      if (event !== 'update' && event !== 'status.update') return;
      try { this.enqueue(JSON.parse(data), 'fedi.buzz'); } catch { /* malformed event */ }
    });
    try {
      for await (const chunk of response.body) {
        if (this.stopped) break;
        resetIdle();
        sse.push(decoder.decode(chunk, { stream: true }));
      }
      sse.push(decoder.decode());
      if (!this.stopped) throw new Error('stream ended');
    } finally {
      this.connected = false;
      clearTimeout(this.idleTimer);
      this.abort = null;
    }
  }

  async _pollAll() {
    if (this.stopped) return;
    this.lastPoll = new Date().toISOString();
    const instances = this.config().instances.filter(i => DEFAULT_INSTANCES.includes(i));
    // Two workers bound concurrent sockets while still preventing one slow
    // instance from holding every other source behind it.
    let next = 0;
    const worker = async () => {
      while (!this.stopped && next < instances.length) {
        const instance = instances[next++];
        await this._pollOne(instance);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  async _pollOne(instance) {
    const state = this.sourceState.get(instance) || { failures: 0, quietUntil: 0 };
    if (state.quietUntil > Date.now()) return;
    try {
      const url = `${instance}/api/v1/timelines/public?local=true&limit=${POLL_LIMIT}`;
      const response = await this.pollFetcher(url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        const error = new Error(`answered ${response.status}`);
        error.status = response.status;
        error.retryAfter = retryAfterMs(response);
        throw error;
      }
      const list = await response.json();
      if (!Array.isArray(list)) throw new Error('returned a non-array timeline');
      state.failures = 0;
      state.quietUntil = 0;
      for (const status of [...list].reverse()) this.enqueue(status, new URL(instance).host);
    } catch (e) {
      state.failures++;
      const terminal = [401, 403, 404, 422].includes(e.status);
      const ladder = terminal ? SOURCE_BACKOFF_MAX_MS
        : Math.min(SOURCE_BACKOFF_MIN_MS * 2 ** (state.failures - 1), SOURCE_BACKOFF_MAX_MS);
      state.quietUntil = Date.now() + (e.retryAfter || Math.round(ladder * (0.85 + Math.random() * 0.3)));
      this.log(`publicfeed ${new URL(instance).host}: ${e.message} — backing off`);
    }
    this.sourceState.set(instance, state);
  }

  _wait(ms) {
    return new Promise(resolve => {
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(() => { this.waitResolve = null; resolve(); }, ms);
      this.waitTimer.unref?.();
    });
  }
}
