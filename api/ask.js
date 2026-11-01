// POST /api/ask  { question, userDoc?: { title, text }, topK? }
// Retrieval-augmented answer over the bundled Northwind Labs knowledge base.
import {
  loadKB, makeDoc, chunkDoc, buildIndex, search, pickSentences, composeExtractive,
} from '../lib/rag.js';

const MAX_QUESTION = 500;
const MAX_USER_DOC = 20000;
const MIN_CONFIDENCE = 0.32; // below this we refuse instead of guessing
const MODEL = 'gemini-2.0-flash';

// Simple per-instance guard: 30 requests / minute / IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 60_000) throw new Error('Body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function generateLive(question, chunks) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.docTitle} › ${c.section}\n${c.text}`)
    .join('\n\n---\n\n');
  const prompt = `You are the internal knowledge assistant for Northwind Labs.
Answer the employee's question using ONLY the numbered context passages below.
Rules:
- Cite every factual sentence with the passage number in square brackets, e.g. [1] or [1][3].
- Be concise: 1–4 sentences, optionally followed by short "- " bullet points. Keep exact numbers, limits and names.
- If the passages do not contain the answer, set "found" to false and answer exactly "I couldn't find this in the docs."
- Never use outside knowledge and never invent policies.
Return JSON: {"found": boolean, "answer": string, "citations": number[]}

Context:
${context}

Question: ${question}`;

  // One retry on rate limits, server errors and timeouts. Any failure after
  // that returns null and the caller falls back to the extractive composer,
  // so a Gemini outage degrades the answer instead of failing the request.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 600, responseMimeType: 'application/json' },
          }),
        },
      );
      if (!r.ok) {
        if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          continue;
        }
        return null;
      }
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      const out = JSON.parse(text);
      if (typeof out.answer !== 'string') return null;
      return out;
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export default async function handler(req, res) {
  try {
    return await handleAsk(req, res);
  } catch (err) {
    // Last-resort guard: the client always gets JSON, never a stack trace.
    console.error('ask handler failed:', err instanceof Error ? err.message : err);
    if (!res.writableEnded) return send(res, 500, { error: 'Something went wrong while answering. Please try again.' });
  }
}

async function handleAsk(req, res) {
  const t0 = performance.now();
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });

  const ip = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'local';
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many questions — please wait a minute.' });

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { error: 'Request body must be a JSON object.' });
  }
  if (body.question !== undefined && typeof body.question !== 'string') {
    return send(res, 400, { error: 'question must be a string.' });
  }
  if (body.userDoc !== undefined && body.userDoc !== null
    && (typeof body.userDoc !== 'object' || Array.isArray(body.userDoc) || typeof body.userDoc.text !== 'string')) {
    return send(res, 400, { error: 'userDoc must be an object with a text string.' });
  }
  if (body.userDoc?.title !== undefined && typeof body.userDoc.title !== 'string') {
    return send(res, 400, { error: 'userDoc.title must be a string.' });
  }
  if (body.topK !== undefined && !Number.isFinite(Number(body.topK))) {
    return send(res, 400, { error: 'topK must be a number.' });
  }

  const question = String(body.question || '').trim().slice(0, MAX_QUESTION);
  if (question.length < 3) return send(res, 400, { error: 'Ask a question (at least 3 characters).' });
  const topK = Math.min(Math.max(parseInt(body.topK, 10) || 5, 1), 8);

  // --- Index: cached KB, or KB + the user's temporary pasted doc -----------
  const coldStart = !globalThis.__kbWarm;
  const kb = loadKB();
  globalThis.__kbWarm = true;
  let index = kb.index;
  let userDocMeta = null;
  if (body.userDoc && typeof body.userDoc.text === 'string' && body.userDoc.text.trim()) {
    const text = body.userDoc.text.slice(0, MAX_USER_DOC);
    const title = String(body.userDoc.title || 'Your pasted document').slice(0, 80);
    const raw = /^#\s/m.test(text) ? text : `# ${title}\n\n${text}`;
    const doc = makeDoc('user-doc', `---\ntitle: ${title}\n---\n${raw}`, { user: true });
    const userChunks = chunkDoc(doc);
    index = buildIndex([...kb.chunks, ...userChunks]);
    userDocMeta = { title, chunks: userChunks.length, truncated: body.userDoc.text.length > MAX_USER_DOC };
  }

  const tr = performance.now();
  const result = search(index, question, topK);
  const picked = pickSentences(index, result);
  const retrievalMs = +(performance.now() - tr).toFixed(2);

  const chunks = result.results.map((c, i) => ({ n: i + 1, ...c }));
  const found = result.confidence >= MIN_CONFIDENCE && picked.length > 0;
  const highlights = {};
  for (const p of picked) (highlights[p.n] ||= []).push(p.text);

  let mode = process.env.GEMINI_API_KEY ? 'live' : 'demo';
  let answer;
  let answerFound = found;
  let generationMs = 0;

  if (!found) {
    const near = [...new Set(chunks.slice(0, 2).map((c) => c.docTitle))];
    answer = `I couldn't find this in the docs.${near.length ? ` The closest matches were in ${near.join(' and ')}, but they don't answer the question.` : ''} Try rephrasing, or paste the relevant document as a temporary source.`;
  } else {
    const tg = performance.now();
    const live = mode === 'live' ? await generateLive(question, chunks) : null;
    generationMs = +(performance.now() - tg).toFixed(1);
    if (live) {
      if (live.found === false) {
        answerFound = false;
        answer = "I couldn't find this in the docs. The retrieved passages are related but don't state the answer.";
      } else {
        // Strip any citation that points outside the retrieved set.
        answer = live.answer.replace(/\[(\d+)\]/g, (m, n) => (+n >= 1 && +n <= chunks.length ? m : ''));
      }
    } else {
      mode = 'demo';
      answer = composeExtractive(picked);
    }
  }

  const citedNums = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]))].sort((a, b) => a - b);

  return send(res, 200, {
    mode,
    found: answerFound,
    answer,
    citations: citedNums.map((n) => {
      const c = chunks[n - 1];
      return { n, chunkId: c.id, docId: c.docId, docTitle: c.docTitle, section: c.section };
    }),
    chunks,
    highlights,
    debug: {
      queryTerms: result.terms,
      expandedTerms: result.expanded,
      unknownTerms: result.unknownTerms,
      confidence: result.confidence,
      threshold: MIN_CONFIDENCE,
      topK,
      ranker: 'BM25 (k1=1.4, b=0.72) + heading boost + synonym expansion',
      generator: mode === 'live' ? `Gemini ${MODEL} (grounded, JSON)` : 'Extractive composer (no LLM)',
      latency: { retrievalMs, generationMs, totalMs: +(performance.now() - t0).toFixed(1) },
      index: {
        docs: kb.docs.length + (userDocMeta ? 1 : 0),
        chunks: index.N,
        vocabulary: index.vocab,
        builtAt: kb.builtAt,
        buildMs: kb.buildMs,
        coldStart,
      },
      userDoc: userDocMeta,
    },
  });
}
