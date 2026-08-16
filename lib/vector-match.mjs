// vector-match.mjs — pure cosine-similarity matching, shared by every
// embedding-backed provider (ai.mjs's OpenAI embeddings, gemini.mjs's Gemini
// embeddings). No network calls here and no provider-specific knowledge:
// callers embed the text themselves and hand in plain vectors, so this stays
// the one place the actual matching math lives instead of drifting between
// two near-identical copies.
//
// Every embedding model used here (OpenAI's text-embedding-3-*, Google's
// text-embedding-004/gemini-embedding-*) returns unit-normalized vectors, so
// cosine similarity is a plain dot product — same assumption the client's
// local SemanticFilterService.apply() makes (ailo's
// renderer/lib/semantic-filter-service.ts).
export function matchVectors({ queries, documents, queryVectors, documentVectors, defaultThreshold = 0.6 }) {
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * (b[i] || 0), 0);
  const matches = [];
  queries.forEach((q, qi) => {
    const threshold = Number.isFinite(q.threshold) ? q.threshold : defaultThreshold;
    documents.forEach((d, di) => {
      const score = dot(queryVectors[qi], documentVectors[di]);
      if (score >= threshold) matches.push({ queryId: q.id, documentId: d.id, score });
    });
  });
  return matches;
}
