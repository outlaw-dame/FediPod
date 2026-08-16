import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKlipyResults, searchGifs } from './klipy.mjs';

test('parses and sanitizes native KLIPY GIF results', () => {
  assert.deepEqual(parseKlipyResults({ data: { data: [{ id: 7, title: 'Wave', file: {
    md: { gif: { url: 'https://media.klipy.com/wave.gif', width: 320, height: 180 } }, sm: { webp: { url: 'https://media.klipy.com/wave.webp' } },
  } }, { id: 8, file: { md: { gif: { url: 'http://unsafe.test/a.gif' } } } }] } }), [{
    id: '7', title: 'Wave', url: 'https://media.klipy.com/wave.gif', preview_url: 'https://media.klipy.com/wave.webp', width: 320, height: 180,
  }]);
});

test('search does not leak query or key through upstream errors', async () => {
  await assert.rejects(searchGifs({ apiKey: 'super-secret', query: 'private query', fetcher: async () => ({ ok: false, status: 500 }) }),
    (error) => error.message === 'KLIPY search failed (500)' && !error.message.includes('super-secret') && !error.message.includes('private query'));
});

test('search uses a non-user integration identifier and clamps count', async () => {
  let requested;
  await searchGifs({ apiKey: 'key', query: 'cats', limit: 200, fetcher: async (url) => {
    requested = url; return { ok: true, json: async () => ({ result: true, data: { data: [] } }) };
  } });
  assert.equal(requested.searchParams.get('customer_id'), 'ailo-fedipod'); assert.equal(requested.searchParams.get('per_page'), '24');
});
