// The pool AI domain moderation-suggestions are allowed to pick from — see
// ai.mjs's suggestModeration for why this exists: asked with no grounding,
// the model invents plausible-sounding "problematic domains" that were never
// actually seen anywhere near this account, which is a plainly wrong
// suggestion no matter how real it reads. Accounts already get this
// discipline (the prompt tells the model never to invent a handle); domains
// need the same thing, and unlike accounts there is no resolveCommunity()
// call downstream that would fail on a domain that doesn't exist — blocking
// an invented domain just silently "succeeds" as a useless blocklist entry.
//
// The pool itself, mirroring Mastodon's own domain-block convention (a
// domain block is a personal decision made about instances you've actually
// had trouble with, not a global reputation list): hostnames of accounts
// this user has already blocked or muted individually, not yet covered by
// an existing domain block. Blocking several accounts on the same instance
// one at a time is exactly the pattern where "just block the domain" is the
// natural next suggestion.

import { normalizeDomain } from './custom-feeds.mjs';

function hostOf(actorUrl) {
  try { return normalizeDomain(new URL(actorUrl).hostname); }
  catch { return null; }
}

/**
 * @param {{ blockedActors?: string[], mutedActors?: string[], blockedDomains?: string[] }} input
 * @returns {{ domain: string, blockedAccounts: number, mutedAccounts: number }[]}
 *   Sorted by strength of signal (blocked accounts first), capped at 20.
 */
export function candidateModerationDomains({ blockedActors = [], mutedActors = [], blockedDomains = [] } = {}) {
  const alreadyBlocked = new Set(
    (Array.isArray(blockedDomains) ? blockedDomains : []).map((d) => String(d || '').toLowerCase()),
  );
  const counts = new Map();
  const tally = (actors, key) => {
    for (const actor of Array.isArray(actors) ? actors : []) {
      const domain = hostOf(actor);
      if (!domain || alreadyBlocked.has(domain)) continue;
      const entry = counts.get(domain) || { blocked: 0, muted: 0 };
      entry[key] += 1;
      counts.set(domain, entry);
    }
  };
  tally(blockedActors, 'blocked');
  tally(mutedActors, 'muted');
  return [...counts.entries()]
    .map(([domain, c]) => ({ domain, blockedAccounts: c.blocked, mutedAccounts: c.muted }))
    .sort((a, b) => (b.blockedAccounts - a.blockedAccounts) || (b.mutedAccounts - a.mutedAccounts) || a.domain.localeCompare(b.domain))
    .slice(0, 20);
}
