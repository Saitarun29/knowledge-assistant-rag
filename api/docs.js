// GET /api/docs            → list of knowledge-base documents
// GET /api/docs?id=pricing → one document (markdown body + its chunks)
import { loadKB } from '../lib/rag.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Use GET' }));
  }
  const kb = loadKB();
  const url = new URL(req.url || '/', 'http://localhost');
  const id = url.searchParams.get('id') || req.query?.id;

  if (id) {
    const doc = kb.docs.find((d) => d.id === id);
    if (!doc) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'Document not found' }));
    }
    return res.end(JSON.stringify({
      ...doc,
      chunkList: kb.chunks.filter((c) => c.docId === id).map(({ id: cid, section }) => ({ id: cid, section })),
    }));
  }

  res.end(JSON.stringify({
    mode: process.env.GEMINI_API_KEY ? 'live' : 'demo',
    docs: kb.docs.map(({ id: did, title, owner, updated, words, chunks }) => ({ id: did, title, owner, updated, words, chunks })),
    stats: { docs: kb.docs.length, chunks: kb.chunks.length, vocabulary: kb.index.vocab, buildMs: kb.buildMs },
  }));
}
