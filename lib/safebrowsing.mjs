// safebrowsing.mjs — thin wrapper around Google's Safe Browsing API v4
// (threatMatches:find), used by /api/v1/ailo/safety/urls/check. One fixed,
// trusted Google endpoint with a server-held key — unlike the URLs this
// agent dereferences from the fediverse (lib/safefetch.mjs's SSRF guard),
// the URLs checked here are only ever sent to Google as request *data*,
// never fetched by this process, so no SSRF exposure to guard against; a
// plain fetch is the same choice ai.mjs/gemini.mjs make for their fixed
// provider endpoints.

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];

async function threatMatches({ apiKey, urls }) {
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client: { clientId: 'fedipod', clientVersion: '1.0' },
      threatInfo: {
        threatTypes: THREAT_TYPES,
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: urls.map((url) => ({ url })),
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || `Safe Browsing request failed (${res.status})`);
  }
  return Array.isArray(body.matches) ? body.matches : [];
}

/** Check a batch of URLs; returns only the ones with at least one threat type. */
export async function checkUrls({ apiKey, urls }) {
  if (!apiKey) throw new Error('a Safe Browsing API key is required');
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean);
  if (!list.length) return { threats: [] };
  const matches = await threatMatches({ apiKey, urls: list });
  const byUrl = new Map();
  for (const m of matches) {
    const url = m?.threat?.url;
    const type = m?.threatType;
    if (!url || !type) continue;
    if (!byUrl.has(url)) byUrl.set(url, new Set());
    byUrl.get(url).add(type);
  }
  return { threats: [...byUrl.entries()].map(([url, types]) => ({ url, threatTypes: [...types] })) };
}

/**
 * Used only to validate a key when Ailo's provider UI tests it (POST
 * .../test). threatMatches:find rejects an empty threatEntries list, so this
 * checks one fixed, known-benign URL — a 200 (matches or not) proves the key
 * works; only a bad-key 400 should fail it.
 */
export async function verifyKey(apiKey) {
  await threatMatches({ apiKey, urls: ['https://www.google.com/'] });
  return {};
}
