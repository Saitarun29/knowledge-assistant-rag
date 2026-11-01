# Internal Knowledge Assistant

Ask a question about your company's own documents and get a short answer with
the passages it came from — or a plain "I couldn't find this in the docs"
when the documents don't cover it.

[Live demo](https://knowledge-assistant-rag-phi.vercel.app) · [Run locally](#run-locally)

**Try three things in the demo:**

1. Ask *"How many vacation days do I get per year?"* — then click the `[1]`
   citation and read the exact passage, highlighted, in the source viewer.
2. Ask *"Do we offer dental insurance?"* — it isn't in the knowledge base, so
   watch it refuse instead of guessing, and open **Retrieval** to see the
   confidence score that caused the refusal.
3. Paste your own text under **Temporary document** and ask about that. It's
   indexed for your questions only and never stored.

## The problem

The answers already exist. They're in a leave policy in Drive, an expense
rule in a wiki page, a runbook nobody can find during an incident, and three
Slack threads from March. So people ask in a channel instead, or message
People, Finance or Security directly — and the same ten questions get answered
by hand, every week, sometimes from memory, sometimes from an out-of-date
copy someone saved.

A general chatbot makes this worse in a specific way: it answers whether or
not the policy says what it claims. For internal questions, a confident wrong
answer about refunds, leave or access is worse than no answer. I built this
assistant around that: retrieve first, answer only from what was retrieved,
cite it, and say so when the docs don't cover the question.

## What it does

1. **Chunks the documents by heading.** Each markdown doc in `kb/` is split
   at its `##`/`###` headings into chunks of about 140 words, with a
   one-block overlap so a rule and its exception stay together
   (`lib/rag.js`, `chunkDoc`).
2. **Ranks with BM25.** Tokens are stemmed and stop-worded; the document
   title and section heading are indexed twice as a mild field boost. A small
   hand-written thesaurus expands how people actually ask ("PTO", "time off")
   into the words the policy uses ("annual leave"), at lower weight.
3. **Checks confidence before answering.** The score measures how much of the
   question the best chunk actually covers, and drops by 0.6× for every word
   the knowledge base has never seen. Below **0.32**, `api/ask.js` returns
   the refusal — the LLM is never called.
4. **Answers from the passages, with citations.** With a Gemini key, Gemini
   2.0 Flash writes a grounded JSON answer; citations pointing outside the
   retrieved set are stripped. Without a key, an extractive composer quotes
   the best sentences from the chunks. Either way, every claim carries a
   `[n]` marker that opens its source.
5. **Shows its working.** The Retrieval panel lists the top chunks with BM25
   scores, query terms (including which ones the knowledge base doesn't
   know), confidence against the threshold, and where the milliseconds went.
6. **Takes a temporary document.** Paste up to 20,000 characters; it's
   chunked and indexed inside that request, alongside the knowledge base,
   and then dropped. Nothing is written anywhere.

The demo corpus is a fictional company, Northwind Labs: 8 documents,
66 chunks — leave, expenses, onboarding, security, product FAQ, pricing, an
incident runbook and a sales playbook.

## Why it's built this way

The full reasoning, with trade-offs, is in
[docs/decisions.md](docs/decisions.md). The short version:

- **Citations on every answer, and a refusal on weak retrieval.** A wrong
  policy answer costs more than "not in the docs". The refusal also tells you
  which document is missing or badly titled.
- **Demo mode needs no key.** Retrieval is the part worth judging, so the
  demo runs it honestly with the extractive composer instead of hiding it
  behind an API key signup.
- **BM25 here, hybrid search in production.** BM25 is deterministic and
  inspectable at this scale. The production schema
  ([`supabase/schema.sql`](supabase/schema.sql)) swaps in pgvector cosine
  search fused with full-text ranking behind the same `/api/ask` contract.
- **A pasted document is never stored.** Its value is checking one document
  you have open; storing it would need an owner, permissions and a delete
  story.
- **If the LLM fails, the request doesn't.** One retry, then the extractive
  composer answers and the response says which mode produced it.

## Architecture

```
Browser (index.html · assets/app.js — chat, source viewer, retrieval panel)
   │  POST /api/ask        GET /api/docs
   ▼
api/ask.js ──► lib/rag.js ──► kb/*.md  (8 sample docs, chunked + BM25-indexed
   │              │              once per cold start, cached in memory)
   │              ├─ confidence < 0.32 ──► refusal, no LLM call
   │              ├─ GEMINI_API_KEY set ─► Gemini 2.0 Flash, grounded JSON
   │              └─ no key / LLM failed ► extractive composer
   ▼
Answer + citations + highlights + debug (terms, scores, confidence, latency)

Production ingest (separate from the demo path):
Google Drive + Notion ──► n8n/knowledge-ingest.n8n.json (every 6 hours)
   ──► chunk (~900 chars, 150 overlap, sha256 change check)
   ──► OpenAI text-embedding-3-small
   ──► Supabase kb_chunks (pgvector + tsvector, acl_groups)
   ──► match_kb_chunks: dense + sparse, Reciprocal Rank Fusion
```

| Folder | What's in it |
|---|---|
| `index.html`, `assets/` | The UI: chat, citation source viewer, retrieval panel, temporary-document paste box. Vanilla JS, no build step. |
| `api/ask.js` | Question endpoint: validation, rate limit, retrieval, confidence guard, live or demo answering. |
| `api/docs.js` | Knowledge-base listing and single-document reads. |
| `lib/rag.js` | Chunking, stemming, BM25 index, synonym expansion, confidence scoring, extractive composer. No dependencies. |
| `kb/` | The sample Northwind Labs documents. Fictional, labelled as such. |
| `n8n/` | `knowledge-ingest.n8n.json` — 19 nodes plus a sticky note; syncs Drive and Notion into Supabase every 6 hours. |
| `supabase/` | `schema.sql` — `kb_chunks` with pgvector HNSW and `tsvector`, `match_kb_chunks` hybrid search with ACL filtering, stale-chunk pruning, and a `kb_questions` answer log. |
| `scripts/` | `dev-server.mjs` (zero-dependency local server) and `smoke.mjs` (API checks that run with no keys). |
| `docs/` | `decisions.md` — the design decisions and their trade-offs. |

## Production notes

What I hold a system like this to before it answers real employees:

- **Validation first.** `/api/ask` rejects a non-object body, a non-string
  `question`, a malformed `userDoc` and a non-numeric `topK` with a JSON
  error and a specific message. Limits: question 500 characters, pasted
  document 20,000 characters, request body 60 KB.
- **Failures return JSON, never a stack trace.** Both API routes wrap their
  work and answer errors as `{ "error": … }` with the right status code.
- **The LLM call can fail safely.** 12-second timeout, one retry on rate
  limits, server errors and timeouts — then the extractive fallback answers
  and the response's `mode` field says so. Nothing crashes because a model
  API had a bad minute.
- **A cost guard, not just a quality guard.** The confidence check runs
  before the model call, so out-of-scope questions never spend a token.
  30 requests per minute per IP per instance caps abuse on the endpoint.
- **Secrets stay server-side.** The Gemini key is read from the environment
  by the API route only. [`.env.example`](.env.example) lists every variable
  the app and the ingest workflow read — names and purposes, no values.
- **Access control belongs in retrieval.** The production schema filters by
  `acl_groups` inside `match_kb_chunks`, so a chunk a person may not read
  can't reach the model through a clever question. The demo corpus is all
  public sample data, so the demo path doesn't need it — a client deployment
  does.
- **Questions are logged in production.** `kb_questions` records the
  question, whether it was found, confidence, chunk ids and latency — that's
  how you find the documents people need but can't find, and it's the raw
  material for an eval set.

## Run locally

Node 18 or newer. No dependencies to install.

```bash
git clone https://github.com/Saitarun29/knowledge-assistant-rag
cd knowledge-assistant-rag
npm run dev
```

That starts `scripts/dev-server.mjs` on http://localhost:3000 in **demo
mode** — no API key, extractive answers, full retrieval panel. `npx vercel
dev` works too, if you prefer Vercel's runtime.

For live answers, set one variable before starting:

```bash
GEMINI_API_KEY=your_key npx vercel dev
```

Check it end to end (also demo mode, no key needed):

```bash
npm test
```

`scripts/smoke.mjs` runs 19 questions through the real API handlers —
in-scope ones that must be answered with citations, out-of-scope ones
("Do we offer dental insurance?", "What is the capital of France?") that
must be refused — plus a temporary-document question, the docs endpoints,
and an invalid question that must return a 400.

**API shape.** `POST /api/ask` with
`{ "question": "…", "userDoc"?: { "title", "text" }, "topK"?: 5 }` returns
`mode`, `found`, `answer`, `citations`, `chunks`, `highlights` and `debug`.
`GET /api/docs` lists the knowledge base; `GET /api/docs?id=pricing` returns
one document with its chunk list.

## Data and privacy

- **Everything in `kb/` is sample data.** Northwind Labs is fictional; the
  policies are plausible, written for this demo, and labelled fictional in
  the UI footer and in this README.
- **The demo stores nothing.** Questions aren't logged, and a pasted
  temporary document lives only for the request on the server and in your
  own browser tab (`sessionStorage`) on the client.
- **A client deployment is different, deliberately.** Documents would live
  in the client's own Drive/Notion and Supabase project, chunks and
  embeddings in their `kb_chunks` table with `acl_groups` set from their
  sharing permissions, and the question log in their `kb_questions` table.
  Their documents don't pass through any account of mine.

## Limitations and roadmap

Honest limits of what's in this repo today:

- The demo's BM25 ranking is lexical. It will miss a well-covered topic asked
  about in completely different words — the thesaurus in `lib/rag.js` only
  covers the phrasings I've seen. Hybrid vector search exists in
  `supabase/schema.sql` but is not wired into `/api/ask` yet.
- No follow-up context: each question is answered on its own. "How many days
  do I get?" then "Can I carry them over?" works because the second question
  stands alone; a pronoun-heavy follow-up won't.
- The extractive composer quotes sentences, so demo answers can read
  abruptly and can't merge two chunks into one sentence.
- The confidence threshold (0.32) was tuned by hand against the sample
  corpus. A real deployment needs a labelled question set and the threshold
  chosen from it, not from feel.
- No eval harness yet. The smoke test checks behaviour on 19 questions; it
  is not a recall or groundedness measurement.

Next, in the order I'd do them for a client: wire `match_kb_chunks` behind
`/api/ask`, build a golden Q&A set from the `kb_questions` log and score
recall and refusal accuracy in CI, then a Slack `/ask` command that answers
in-thread with the same citations.

## Work with me

I'm Sai Tarun Ronanki, an AI Agents & Workflow Automation Consultant based in
Hyderabad. I build systems like this one for businesses whose answers and
follow-ups are scattered across Docs, Drive, Slack and inboxes — agents and
automations that survive production, with citations, refusal paths and
exceptions going to a human instead of being silently dropped.

If your team keeps re-answering the same questions by hand:
**hello@saitarun.com** · [saitarun.com](https://saitarun.com) ·
[LinkedIn](https://www.linkedin.com/in/saitarunronanki) ·
[Instagram @tarunaistudio](https://www.instagram.com/tarunaistudio)

More of my work:

- [AI Lead Qualifier](https://github.com/Saitarun29/ai-lead-qualifier) —
  scores and routes inbound leads, with an exceptions queue for the ones a
  human should decide.
- [Content Ops Pipeline](https://github.com/Saitarun29/content-ops-pipeline) —
  a content workflow that checks its own output before anything is scheduled.
- [Portfolio](https://github.com/Saitarun29/sai-tarun-portfolio) — the rest
  of the projects, in one place.

MIT licensed. Northwind Labs and all sample documents are fictional.
