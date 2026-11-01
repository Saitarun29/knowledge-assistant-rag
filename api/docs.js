// GET /api/docs            → list of knowledge-base documents
// GET /api/docs?id=pricing → one document (markdown body + its chunks)
import { loadKB } from '../lib/rag.js';

function fail(res, status, error) {
  res.statusCode = status;
  return res.end(JSON.stringify({ error }));
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (req.method !== 'GET') return fail(res, 405, 'Use GET');

  try {
    const kb = loadKB();
    const url = new URL(req.url || '/', 'http://localhost');
    const id = url.searchParams.get('id') || req.query?.id;
    if (id !== undefined && id !== null && typeof id !== 'string') {
      return fail(res, 400, 'id must be a string.');
    }

    if (id) {
      const doc = kb.docs.find((d) => d.id === id);
      if (!doc) return fail(res, 404, 'Document not found');
      return res.end(JSON.stringify({
        ...doc,
        chunkList: kb.chunks.filter((c) => c.docId === id).map(({ id: cid, section }) => ({ id: cid, section })),
      }));
    }

    return res.end(JSON.stringify({
      mode: process.env.GEMINI_API_KEY ? 'live' : 'demo',
      docs: kb.docs.map(({ id: did, title, owner, updated, words, chunks }) => ({ id: did, title, owner, updated, words, chunks })),
      stats: { docs: kb.docs.length, chunks: kb.chunks.length, vocabulary: kb.index.vocab, buildMs: kb.buildMs },
    }));
  } catch (err) {
    // The client always gets JSON, never a stack trace.
    console.error('docs handler failed:', err instanceof Error ? err.message : err);
    return fail(res, 500, 'Could not load the knowledge base. Please try again.');
  }
}
