# Decisions

Why this assistant is built the way it is. Each entry is a real choice in the
code, with the trade-off I accepted. Newest context first; the dates are when
the choice was made.

## 1. Answers cite sources, and weak retrieval means a refusal — not a guess

*31 October 2026 · `api/ask.js`, `lib/rag.js`*

Every factual sentence in an answer carries a `[n]` citation that opens the
exact passage it came from. Before anything is generated, retrieval has to
clear a confidence threshold (0.32): the score combines how much of the
question's information the best chunk actually covers, saturated by its BM25
score, and is multiplied by 0.6 for every word the knowledge base has never
seen. Below the threshold the API returns "I couldn't find this in the docs",
names the closest documents if there are any, and never calls the LLM.

**Trade-off:** some answerable questions get refused, especially ones phrased
with words the docs don't use. I accept that. In a company setting a wrong
policy answer ("yes, you can expense that") costs more than a refusal that
points you at the right document — and a refusal is a signal that the doc is
missing or badly titled, which is fixable. Citations returned by the LLM that
point outside the retrieved set are stripped in `api/ask.js`, so a citation
can't be invented either.

## 2. Demo mode needs no API key

*31 October 2026 · `api/ask.js`, `lib/rag.js` (`composeExtractive`)*

Without `GEMINI_API_KEY`, the assistant still answers: an extractive composer
picks the best sentences from the retrieved chunks — with small boosts for the
kind of answer the question asks for (a number, a role, a range that contains
an amount like "$2,000") — and cites them. Anyone can clone the repo, run one
command, and evaluate the retrieval honestly.

**Trade-off:** extractive answers read like quoted passages, not prose, and
they can't combine facts from two chunks gracefully. That's the point of the
trade: the demo never pretends to be the live model, the mode badge in the UI
says which one you're looking at, and evaluation of the part that matters most
— retrieval — isn't hidden behind an API key.

## 3. BM25 for the demo, hybrid vector search for production

*31 October 2026 · `lib/rag.js`, `supabase/schema.sql`*

The shipped demo ranks with a hand-written BM25 index (k1 = 1.4, b = 0.72)
over the markdown in `kb/`. It's deterministic, needs no embeddings call and
no database, and builds in about 35 ms for the sample corpus — which makes the
retrieval debug view meaningful: you can see exactly why a chunk ranked.

The production path in `supabase/schema.sql` is different on purpose: pgvector
cosine search plus `tsvector` full-text, merged with Reciprocal Rank Fusion in
`match_kb_chunks`, because at real corpus size people ask questions in words
the docs don't use and pure keyword ranking misses too much.

**Trade-off:** two ranking systems to reason about, and their scores are not
comparable. I keep the `/api/ask` contract identical so the UI and the refusal
logic don't change when the ranker is swapped.

## 4. A pasted document is indexed per request and never stored

*31 October 2026 · `api/ask.js`, `assets/app.js`*

The "temporary document" feature lets someone paste up to 20,000 characters
and ask questions against it alongside the knowledge base. The server chunks
and indexes it inside that single request and then drops it. The browser keeps
the text in `sessionStorage` for the tab, and the UI says so plainly.

**Trade-off:** every question re-indexes the pasted text (cheap at 20,000
characters) and nothing can be shared or revisited later. For a feature whose
whole value is "let me check something against this document I have open",
not storing it is the correct default — a stored copy would need an owner,
permissions and a delete story.

## 5. Heading-aware chunks of about 140 words, with overlap

*31 October 2026 · `lib/rag.js` (`chunkDoc`)*

Documents split at their `##`/`###` headings first, because a policy section
is a unit of meaning. Sections longer than roughly 140 words split on
paragraph boundaries and carry the last block (under 60 words) into the next
chunk, so a rule and its exception don't end up in different chunks.

**Trade-off:** chunk sizes vary and a short section can be too small to rank
well on its own. The heading boost in the index (title and section are indexed
twice) compensates, and varied sizes beat fixed windows that cut mid-sentence.
The n8n ingest uses character-based chunks (~900 chars, 150 overlap) instead,
because Drive and Notion exports don't have reliable heading structure — same
idea, adapted to messier input.

## 6. A small hand-written thesaurus instead of LLM query rewriting

*1 November 2026 · `lib/rag.js` (`SYNONYMS`, `PHRASES`)*

People ask about "PTO", "vacation" and "time off"; the policy says "annual
leave". `lib/rag.js` carries a small domain thesaurus and phrase map that
expands query terms at 0.45 weight, so expansion helps ranking without
outvoting the words the person actually used. The debug view shows expanded
terms separately, so the expansion is inspectable.

**Trade-off:** the thesaurus only covers what I've seen people ask, and
maintaining it is manual. An LLM query rewrite would generalise better but
adds a paid call, latency and a failure mode to every question — including in
demo mode, which has to work with no key. For a bounded company vocabulary,
a list I can read in one screen wins.

## 7. If the LLM fails, the answer falls back instead of the request failing

*1 November 2026 · `api/ask.js` (`generateLive`)*

The Gemini call has a 12-second timeout and one retry for rate limits, server
errors and timeouts. If it still fails — bad key, outage, malformed JSON — the
request doesn't error: it drops to the same extractive composer demo mode
uses, and the response reports `mode: "demo"` so the UI badge is honest about
what produced the answer.

**Trade-off:** a user can get a plainer answer without an obvious error to
report. The mode field and the debug view record which generator ran, so the
degradation is visible to anyone operating the system rather than silent.
