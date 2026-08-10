import { readCapped, safeFetch } from './safefetch.mjs';

export const COLLECTION_SOURCES = Object.freeze([
  {
    id: 'wordpress-community', name: 'WordPress Community on Mastodon',
    url: 'https://wp-community-on-mastodon.wptoots.social/',
    description: 'A curated directory of WordPress community members with public Mastodon accounts.',
    importHint: 'Import the complete public directory.',
  },
  {
    id: 'fedidevs', name: 'FediDevs Starter Packs',
    url: 'https://fedidevs.com/starter-packs/',
    description: 'Community-created starter packs published as native ActivityPub Collections.',
    importHint: 'Open the directory and paste the URL of one starter pack.',
  },
  {
    id: 'mastodon-migration', name: 'Mastodon Follow Pack Directory',
    url: 'https://mastodonmigration.wordpress.com/2024/11/20/mastodon-follow-pack-directory-nov-20-2024/',
    description: 'Topic-based follow packs with public CSV exports and a published opt-out process.',
    importHint: 'Open the directory and paste one pack’s Google Sheets CSV link.',
  },
]);

const WP_PAGE = COLLECTION_SOURCES[0].url;
const WP_CSV = 'https://wp-community-on-mastodon.wptoots.social/resources/users.csv';
const MIGRATION_PAGE = COLLECTION_SOURCES[2].url;
const MAX_IMPORT_ACCOUNTS = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const plain = (value, max) => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const canonicalHandle = (value) => {
  const handle = String(value || '').trim().replace(/^acct:/i, '').replace(/^@/, '');
  return /^[^@\s/,?#]+@[^@\s/,?#]+\.[^@\s/,?#]+$/.test(handle) ? `@${handle}` : null;
};

// RFC 4180-shaped parser, including quoted commas, escaped quotes and CRLF.
// Source files are capped before reaching it and rows are capped afterwards.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(v => v.trim())) rows.push(row);
      row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('source CSV has an unterminated quoted field');
  row.push(field.replace(/\r$/, ''));
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

function dedupe(accounts) {
  const seen = new Set();
  const out = [];
  for (const account of accounts) {
    const key = String(account.url || account.handle || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(account);
    if (out.length >= MAX_IMPORT_ACCOUNTS) break;
  }
  return out;
}

export function parseWordPressCsv(text) {
  const rows = parseCsv(text);
  const header = (rows.shift() || []).map(v => v.trim().toLowerCase());
  const accountAt = header.indexOf('account');
  const linkAt = header.indexOf('link');
  if (accountAt < 0) throw new Error('WordPress directory CSV has no account column');
  return dedupe(rows.map(row => ({
    handle: canonicalHandle(row[accountAt]),
    url: /^https:\/\//i.test(String(row[linkAt] || '').trim()) ? String(row[linkAt]).trim() : null,
  })).filter(a => a.handle));
}

export function parseMigrationCsv(text) {
  const rows = parseCsv(text);
  let name = '';
  const accounts = [];
  for (const row of rows) {
    const handle = row.map(canonicalHandle).find(Boolean);
    if (!handle) continue;
    name ||= plain(row.find(v => !canonicalHandle(v)), 40);
    accounts.push({ handle, url: null });
  }
  return { name: name || 'Mastodon Follow Pack', accounts: dedupe(accounts) };
}

export function parseFediDevsCollection(text, requestedUrl) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('FediDevs did not return an ActivityPub Collection'); }
  const requested = new URL(requestedUrl);
  let identified;
  try { identified = new URL(doc?.id); } catch { throw new Error('FediDevs Collection has no valid id'); }
  // FediDevs currently emits an http id for its https document. Accept that
  // one scheme mismatch only; host and path must still be the exact pack asked
  // for, so a response cannot redirect the import to another collection.
  if (identified.host !== requested.host || identified.pathname !== requested.pathname
    || ![].concat(doc.type || []).includes('Collection')) {
    throw new Error('FediDevs Collection identity does not match the requested pack');
  }
  const accounts = dedupe([].concat(doc.items || doc.orderedItems || [])
    .map(value => typeof value === 'string' ? { url: value, handle: null } : null)
    .filter(a => a && /^https:\/\//i.test(a.url)));
  return {
    name: plain(doc.name, 40) || 'FediDevs Starter Pack',
    description: plain(doc.summary, 100), accounts,
  };
}

export function classifyCollectionSource(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { throw new Error('source must be a valid https URL'); }
  if (url.protocol !== 'https:') throw new Error('collection sources must use https');
  url.hash = '';
  if (url.hostname === 'wp-community-on-mastodon.wptoots.social'
    && (url.pathname === '/' || url.pathname === '/resources/users.csv')) {
    return { kind: 'wordpress-community', url: WP_CSV, page: WP_PAGE };
  }
  if (url.hostname === 'fedidevs.com') {
    const match = /^\/s\/([A-Za-z0-9_-]+)\/$/.exec(url.pathname);
    if (!match) throw new Error('open FediDevs and paste an individual starter-pack URL (/s/…/)');
    url.search = '';
    return { kind: 'fedidevs', url: url.href, page: url.href };
  }
  if (url.hostname === 'docs.google.com'
    && /^\/spreadsheets\/d\/e\/[A-Za-z0-9_-]+\/pub$/.test(url.pathname)
    && url.searchParams.get('output') === 'csv') {
    return { kind: 'mastodon-migration', url: url.href, page: MIGRATION_PAGE };
  }
  if (url.hostname === 'mastodonmigration.wordpress.com') {
    throw new Error('open the directory and paste one pack’s Google Sheets CSV link');
  }
  throw new Error('source is not one of the configured public Collection directories');
}

async function fetchText(url, accept, fetcher = safeFetch) {
  const res = await fetcher(url, { headers: { accept } });
  if (!res?.ok) throw new Error(`source returned HTTP ${res?.status || 'error'}`);
  return readCapped(res, MAX_IMPORT_BYTES);
}

function migrationLinks(html) {
  return new Set([...String(html).matchAll(/href=["'](https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[A-Za-z0-9_-]+\/pub\?output=csv)["']/gi)]
    .map(match => match[1].replaceAll('&amp;', '&')));
}

export async function loadCollectionSource(input, { fetcher = safeFetch } = {}) {
  const source = classifyCollectionSource(input);
  if (source.kind === 'wordpress-community') {
    const accounts = parseWordPressCsv(await fetchText(source.url, 'text/csv', fetcher));
    return {
      ...source, name: 'WordPress Community',
      description: 'Public opt-in directory from wp-community-on-mastodon.wptoots.social', accounts,
    };
  }
  if (source.kind === 'fedidevs') {
    const parsed = parseFediDevsCollection(
      await fetchText(source.url, 'application/activity+json', fetcher), source.url,
    );
    return { ...source, ...parsed };
  }
  const directory = await fetchText(MIGRATION_PAGE, 'text/html', fetcher);
  if (!migrationLinks(directory).has(source.url)) {
    throw new Error('that CSV is not currently listed by the Mastodon Follow Pack Directory');
  }
  const parsed = parseMigrationCsv(await fetchText(source.url, 'text/csv', fetcher));
  return {
    ...source, ...parsed,
    description: 'Public follow pack from the Mastodon Migration directory',
  };
}
