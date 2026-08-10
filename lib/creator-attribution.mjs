import net from 'node:net';

import { readCapped, safeFetch } from './safefetch.mjs';
import * as social from './social.mjs';

const MAX_DOMAINS = 100;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_URL_CHARS = 2692;
const MAX_QUEUED = 100;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_m, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&commat;/gi, '@').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attrs(tag) {
  const out = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    const key = match[1].toLowerCase();
    if (key === '<meta' || key === '<link' || key === '<a') continue;
    out[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

function validDomain(value) {
  let raw = String(value || '').trim().toLowerCase();
  raw = raw.replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!raw || raw.length > 253 || /[/\\?#@:\s]/.test(raw)) return null;
  let host;
  try { host = new URL(`https://${raw}/`).hostname.toLowerCase(); } catch { return null; }
  if (net.isIP(host) || !host.includes('.') || host.length > 253) return null;
  if (!host.split('.').every(label => label && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return host;
}

export function normalizeAttributionDomains(values) {
  const input = Array.isArray(values) ? values : values == null ? [] : [values];
  if (input.length > MAX_DOMAINS) throw new Error(`at most ${MAX_DOMAINS} attribution domains are allowed`);
  const out = [];
  const seen = new Set();
  for (const value of input) {
    const domain = validDomain(value);
    if (!domain) throw new Error(`invalid attribution domain: ${String(value || '')}`);
    if (!seen.has(domain)) { seen.add(domain); out.push(domain); }
  }
  return out;
}

export function domainAllowsAttribution(domains, hostname) {
  const host = validDomain(hostname);
  if (!host) return false;
  const allowed = new Set();
  for (const value of [].concat(domains || []).slice(0, MAX_DOMAINS)) {
    const normalized = validDomain(value);
    if (normalized) allowed.add(normalized);
  }
  const labels = host.split('.');
  return labels.some((_label, index) => allowed.has(labels.slice(index).join('.')));
}

function metaMap(html) {
  const head = String(html || '').split(/<\/head\s*>/i, 1)[0];
  const map = new Map();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(match[0]);
    const key = String(a.property || a.name || '').toLowerCase();
    if (key && a.content != null && !map.has(key)) map.set(key, a.content);
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  if (title && !map.has('title')) map.set('title', decodeEntities(title.replace(/<[^>]*>/g, '')));
  return { head, map };
}

function absoluteHttpUrl(value, base, sameOrigin = false) {
  if (!value || String(value).length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(String(value), base);
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || (sameOrigin && url.origin !== origin.origin)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function firstPreviewUrl(content, statusUrl = null) {
  for (const match of String(content || '').matchAll(/<a\b[^>]*>/gi)) {
    const a = attrs(match[0]);
    const classes = String(a.class || '').split(/\s+/);
    const rels = String(a.rel || '').split(/\s+/);
    if (rels.includes('tag') || classes.includes('u-url') || classes.includes('h-card')) continue;
    const url = absoluteHttpUrl(a.href, statusUrl || a.href);
    if (!url) continue;
    try {
      if (statusUrl && new URL(url).origin === new URL(statusUrl).origin) continue;
    } catch { /* already validated */ }
    return url;
  }
  return null;
}

const clipped = (value, max) => decodeEntities(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function fetchCreatorPreview(status, {
  fetcher = safeFetch,
  resolveCreator,
} = {}) {
  const originalUrl = firstPreviewUrl(status?.content, status?.link || status?.noteId);
  if (!originalUrl) return null;
  const res = await fetcher(originalUrl, {
    headers: { accept: 'text/html, application/xhtml+xml;q=0.9' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res?.ok || !String(res.headers?.get?.('content-type') || '').toLowerCase().includes('text/html')) return null;
  const html = await readCapped(res, MAX_HTML_BYTES);
  const fetchedUrl = absoluteHttpUrl(res.url || originalUrl, originalUrl) || originalUrl;
  const { head, map } = metaMap(html);
  let canonical = fetchedUrl;
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(match[0]);
    if (String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical')) {
      canonical = absoluteHttpUrl(a.href, fetchedUrl, true) || canonical;
      break;
    }
  }
  canonical = absoluteHttpUrl(map.get('og:url'), fetchedUrl, true) || canonical;
  const title = clipped(map.get('og:title') || map.get('title'), 200);
  if (!title) return null;
  const creator = clipped(map.get('fediverse:creator'), 320);
  let creatorInfo = null;
  if (creator && resolveCreator && /^@?[^@\s]+@[^@\s]+$/.test(creator)) {
    creatorInfo = await resolveCreator(creator.replace(/^@/, '')).catch(() => null);
  }
  const domain = new URL(canonical).hostname;
  const allowed = creatorInfo
    ? domainAllowsAttribution(creatorInfo.attributionDomains, domain) : false;
  const authorName = clipped(map.get('article:author') || map.get('og:author') || '', 120);
  return {
    url: originalUrl, canonicalUrl: canonical, title,
    description: clipped(map.get('og:description') || map.get('description'), 500),
    type: 'link', providerName: clipped(map.get('og:site_name'), 120),
    providerUrl: new URL(canonical).origin,
    authors: authorName || allowed ? [{
      name: authorName, url: '', actor: allowed ? creatorInfo.actor : null,
    }] : [],
    missingAttribution: Boolean(creatorInfo?.isSelf && !allowed),
  };
}

export class CreatorPreviewService {
  constructor({ agent, log = console.log, fetcher = safeFetch, concurrency = 2 }) {
    this.agent = agent;
    this.log = log;
    this.fetcher = fetcher;
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.pending = new Set();
    this.done = new Set();
    this.retries = new Map();
  }

  enqueue(status) {
    if (!status?.noteId || this.pending.has(status.noteId) || this.done.has(status.noteId) || status.card
      || status.direct || status.nonPublic || status.quoteOf || status.attachments?.length) return;
    if (!firstPreviewUrl(status.content, status.link || status.noteId)) return;
    const retry = this.retries.get(status.noteId);
    if (retry?.nextAt > Date.now()) return;
    this.pending.add(status.noteId);
    if (this.queue.length >= MAX_QUEUED) {
      this.pending.delete(status.noteId);
      this.log('creator preview queue full — newest link deferred');
      return;
    }
    this.queue.push(structuredClone(status));
    this.drain();
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const status = this.queue.shift();
      this.active++;
      this.fetch(status).then(card => {
        if (card) this.agent.store.updateStatus(status.noteId, { card });
        this.done.add(status.noteId);
        this.retries.delete(status.noteId);
      }).catch(error => {
        const attempts = (this.retries.get(status.noteId)?.attempts || 0) + 1;
        const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 6));
        this.retries.set(status.noteId, { attempts, nextAt: Date.now() + delay });
        this.log(`creator preview ${status.noteId}: ${error.message}; retry in ${Math.round(delay / 1000)}s`);
      }).finally(() => {
        this.pending.delete(status.noteId);
        this.active--;
        this.drain();
      });
    }
  }

  async resolveCreator(handle) {
    const cfg = this.agent.store.getConfig() || {};
    let selfHost = '';
    try { selfHost = new URL(this.agent.publisher.urls.actor).host.toLowerCase(); } catch {}
    const clean = String(handle).replace(/^@/, '').toLowerCase();
    if (clean === `${String(cfg.handle || '').toLowerCase()}@${selfHost}`) {
      return { actor: this.agent.publisher.urls.actor, attributionDomains: cfg.attributionDomains || [], isSelf: true };
    }
    const doc = await social.resolveHandle(this.agent, clean, { counts: false });
    return { actor: doc.id, attributionDomains: doc.attributionDomains || [], isSelf: false };
  }

  fetch(status) {
    return fetchCreatorPreview(status, {
      fetcher: this.fetcher,
      resolveCreator: handle => this.resolveCreator(handle),
    });
  }
}
