# Changelog

## 2026-11-01 — Design refinement and production pass

- Removed the gradient theme completely. The UI is now flat ink-blue and
  grey with a reading-room layout — serif source excerpts, quiet panels —
  and amber is used only for citations and source markers.
- Rewrote the README in full: no badge wall, the problem stated plainly,
  production notes, data and privacy, and honest limitations.
- Added `docs/decisions.md` (why answers cite and refuse, why demo mode
  needs no key, BM25 vs hybrid search, and more) and this changelog.
- Added `.env.example` listing every variable the app and the n8n ingest
  read, with a one-line purpose each and no values.
- `api/ask.js`: stricter input validation (body shape, `question`,
  `userDoc`, `topK`), one retry on the Gemini call for rate limits, server
  errors and timeouts before falling back to the extractive composer, and a
  top-level guard so failures return a JSON error instead of a stack trace.
- `api/docs.js`: same JSON-error treatment and `id` validation.
- `package.json`: added `engines` (Node ≥ 18) and a `smoke` script.
- Footer contact is now hello@saitarun.com; removed a dead `og:image`
  reference and the empty `docs/.gitkeep`.

## 2026-11-01 — README polish

- Tightened the README wording and structure after the first release.

## 2026-11-01 — Live demo URL

- Fixed the live demo link to point at the deployed Vercel URL
  (knowledge-assistant-rag-phi.vercel.app).

## 2026-10-31 — Initial release

- Chat UI with inline citations, a source viewer with highlighted passages,
  and a retrieval debug view (confidence, BM25 scores, latency breakdown).
- `lib/rag.js`: heading-aware chunking (~140 words with overlap), BM25
  ranking with heading boost and synonym expansion, a confidence guard that
  refuses below 0.32, and an extractive answer composer for demo mode.
- `api/ask.js` and `api/docs.js` on Vercel functions; optional live answers
  from Gemini 2.0 Flash with citations validated against the retrieved set.
- Sample knowledge base: 8 fictional Northwind Labs documents (66 chunks).
- Temporary document support: paste up to 20,000 characters, indexed per
  request and never stored.
- Production ingest path: n8n workflow syncing Google Drive and Notion into
  Supabase pgvector every 6 hours, plus `supabase/schema.sql` with hybrid
  search (`match_kb_chunks`), ACL filtering and stale-chunk pruning.
- `scripts/smoke.mjs` covering in-scope and out-of-scope questions, the
  temporary-document path, and invalid input.
