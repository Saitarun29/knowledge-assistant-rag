// Dependency-free retrieval core: markdown loading, heading-aware chunking,
// BM25 ranking, confidence scoring and extractive answer composition.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------
export const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before
being below between both but by can could did do does doing down during each few for from further had has have having
he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of
off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them
themselves then there these they this those through to too under until up very was we were what when where which while
who whom why will with would you your yours yourself yourselves get got gets tell know want need please many much us
let lets also may might must shall using use per one two any every there's what's whats how's hows i'm im ive i've
dont don't doesnt doesn't isnt isn't northwind labs happen happens happened allowed okay ok exactly actually
really anything something thing things like long soon often handle deal`.split(/\s+/).filter(Boolean));

// Small domain thesaurus: lifts recall for how people actually ask questions.
export const SYNONYMS = {
  vacation: ['leave', 'annual'], pto: ['leave', 'annual'], holiday: ['leave', 'holidays'], holidays: ['holiday', 'leave'],
  off: ['leave'], sick: ['sick', 'illness'], maternity: ['parental'], paternity: ['parental'], baby: ['parental'],
  reimburse: ['expense', 'reimbursed'], reimbursement: ['expense', 'reimbursed'], claim: ['expense', 'submit'],
  hotel: ['hotels', 'night'], flight: ['flights'], travel: ['travel', 'flights', 'hotels'], meal: ['meals', 'per diem'],
  dinner: ['meals', 'client'], laptop: ['device', 'laptop'], computer: ['laptop', 'device'], password: ['passwords', '1password'],
  mfa: ['multi-factor', 'authentication'], '2fa': ['multi-factor', 'authentication'], phishing: ['phishing', 'report'],
  outage: ['incident', 'sev1'], down: ['outage', 'incident'], incident: ['incident', 'sev1'], page: ['pagerduty', 'on-call'],
  cost: ['price', 'pricing'], price: ['pricing', 'plan'], prices: ['pricing', 'plan'], expensive: ['price', 'discount'],
  discount: ['discount', 'approval'], refund: ['refunds', 'refunded', 'cancelled'], cancel: ['cancellations', 'cancelled'],
  sla: ['uptime', 'sla'], uptime: ['sla', 'uptime'], hosted: ['hosted', 'region'], gdpr: ['gdpr', 'compliant'],
  integrations: ['connectors', 'integrations'], integration: ['connectors'], connectors: ['integrations'],
  newhire: ['onboarding'], onboarding: ['onboarding', 'first'], start: ['day', 'first'], buddy: ['buddy', 'onboarding'],
  commission: ['commission', 'acv'], lead: ['leads', 'inbound'], leads: ['lead', 'inbound'], objection: ['objections'],
  lose: ['lost', 'stolen', 'report'], lost: ['lost', 'stolen'], stolen: ['lost', 'stolen'], fast: ['acknowledge', 'response'],
  quickly: ['acknowledge', 'response'], respond: ['response', 'acknowledge'], deadline: ['within', 'days'],
  ai: ['ai', 'llm', 'chatgpt'], chatgpt: ['ai', 'tools'], trial: ['free', 'trial'], quota: ['overages', 'tasks'],
};

// Multi-word phrases people use that the docs phrase differently.
export const PHRASES = {
  'first day': ['day one', 'welcome', 'setup'], 'day one': ['first day'], 'time off': ['leave'],
  'work from home': ['remote', 'home office'], 'new hire': ['onboarding', 'new hire'], 'on call': ['on-call', 'pagerduty'],
  'how fast': ['acknowledge', 'response target'], 'how quickly': ['acknowledge', 'response target'],
};

export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (/(ch|sh|x|ss)es$/.test(s) && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) s = s.slice(0, -1);
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (/(er|al)$/.test(s) && s.length > 6) s = s.slice(0, -2);
  if (s.endsWith('e') && s.length > 4) s = s.slice(0, -1);
  return s;
}

export function words(text) {
  return (text.toLowerCase().normalize('NFKD').replace(/(\d),(?=\d{3})/g, '$1').match(/[a-z0-9][a-z0-9$%.\-']*[a-z0-9%]|[a-z0-9]/g) || [])
    .map((w) => w.replace(/'s$/, '').replace(/[.']/g, (c) => (c === '.' && /\d\.\d/.test(w) ? c : '')));
}

export function tokenize(text) {
  const out = [];
  for (const w of words(text)) {
    if (STOPWORDS.has(w) || w.length < 2) continue;
    out.push(stem(w));
    // "on-call" also indexes "on" / "call", "us-east-1" also "east" …
    if (w.includes('-')) for (const p of w.split('-')) if (p.length > 1 && !STOPWORDS.has(p)) out.push(stem(p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown → docs → chunks
// ---------------------------------------------------------------------------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m ? raw.slice(m[0].length) : raw };
}

export function makeDoc(id, raw, extra = {}) {
  const { meta, body } = parseFrontmatter(raw);
  const h1 = body.match(/^#\s+(.+)$/m);
  return {
    id,
    title: meta.title || (h1 ? h1[1].trim() : id),
    owner: meta.owner || extra.owner || '—',
    updated: meta.updated || extra.updated || '',
    body: body.trim(),
    words: words(body).length,
    ...extra,
  };
}

const MAX_CHUNK_WORDS = 140;

// Heading-aware chunking: one chunk per H2 section; long sections are split on
// paragraph boundaries with a one-block overlap so no fact is cut in half.
export function chunkDoc(doc) {
  const lines = doc.body.split('\n');
  const sections = [];
  let cur = { heading: 'Overview', lines: [] };
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue; // H1 = doc title, carried on every chunk
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) {
      if (cur.lines.join('').trim()) sections.push(cur);
      cur = { heading: h[1].trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim()) sections.push(cur);

  const chunks = [];
  for (const s of sections) {
    const blocks = s.lines.join('\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    let buf = [];
    let count = 0;
    const flush = () => {
      if (!buf.length) return;
      chunks.push({ heading: s.heading, text: buf.join('\n\n') });
    };
    for (const b of blocks) {
      const n = words(b).length;
      if (count + n > MAX_CHUNK_WORDS && buf.length) {
        flush();
        const last = buf[buf.length - 1];
        buf = words(last).length < 60 ? [last] : [];
        count = buf.length ? words(last).length : 0;
      }
      buf.push(b);
      count += n;
    }
    flush();
  }
  return chunks.map((c, i) => ({
    id: `${doc.id}#${i + 1}`,
    docId: doc.id,
    docTitle: doc.title,
    section: c.heading,
    text: c.text,
    user: !!doc.user,
  }));
}

// ---------------------------------------------------------------------------
// BM25 index
// ---------------------------------------------------------------------------
const K1 = 1.4;
const B = 0.72;

export function buildIndex(chunks) {
  const df = new Map();
  const docs = chunks.map((c) => {
    // Title and section heading are indexed twice → mild field boost.
    const head = `${c.docTitle} ${c.section}`;
    const toks = tokenize(`${head} ${head} ${plain(c.text)}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const N = chunks.length;
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / Math.max(N, 1);
  const idf = new Map();
  let maxIdf = 0;
  for (const [t, n] of df) {
    const v = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    idf.set(t, v);
    if (v > maxIdf) maxIdf = v;
  }
  return { chunks, docs, idf, N, avgdl, maxIdf, vocab: df.size };
}

export function expandQuery(question) {
  const base = tokenize(question);
  const raw = words(question).filter((w) => !STOPWORDS.has(w));
  const expanded = [];
  const lower = question.toLowerCase();
  for (const [ph, syn] of Object.entries(PHRASES)) {
    if (!lower.includes(ph)) continue;
    for (const t of tokenize(syn.join(' '))) if (!base.includes(t) && !expanded.includes(t)) expanded.push(t);
  }
  for (const w of raw) {
    for (const s of SYNONYMS[w] || []) {
      for (const t of tokenize(s)) if (!base.includes(t) && !expanded.includes(t)) expanded.push(t);
    }
  }
  // Words the KB has never seen and we have no synonym for are usually the
  // real subject of an out-of-scope question ("dental", "wifi", "France").
  const known = new Set(raw.filter((w) => SYNONYMS[w]).map(stem));
  return { terms: [...new Set(base)], expanded, known };
}

export function search(index, question, k = 5) {
  const { terms, expanded, known } = expandQuery(question);
  const unknownTerms = terms.filter((t) => !index.idf.has(t) && !known.has(t) && !/^[\d.%]+$/.test(t));
  const weights = new Map();
  for (const t of terms) weights.set(t, 1);
  for (const t of expanded) if (!weights.has(t)) weights.set(t, 0.45);

  const scored = index.docs.map((d, i) => {
    let score = 0;
    const matched = [];
    for (const [t, w] of weights) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = index.idf.get(t) || 0;
      score += w * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / index.avgdl)));
      matched.push(t);
    }
    return { i, score, matched };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  // Confidence = share of the question's information (idf mass) the best chunk
  // actually covers. Unknown words count at max idf, so off-topic questions
  // ("dental insurance") score low even if a generic word matches.
  const idfOf = (t) => index.idf.get(t) ?? index.maxIdf;
  const totalMass = terms.filter((t) => index.idf.has(t) || !/^[\d.%]+$/.test(t)).reduce((a, t) => a + idfOf(t), 0) || 1;
  const coverage = (s) => {
    if (!s) return 0;
    const hitDirect = terms.filter((t) => s.matched.includes(t)).reduce((a, t) => a + idfOf(t), 0);
    const hitSyn = expanded.length && terms.some((t) => !s.matched.includes(t)) &&
      expanded.some((t) => s.matched.includes(t)) ? 0.35 * index.maxIdf : 0;
    return Math.min(1, (hitDirect + hitSyn) / totalMass);
  };

  const top = scored.slice(0, k).map((s) => ({
    ...index.chunks[s.i],
    score: +s.score.toFixed(3),
    coverage: +coverage(s).toFixed(3),
    matchedTerms: s.matched,
  }));
  const best = top[0];
  let confidence = best ? Math.min(1, coverage(scored[0]) * Math.min(1, best.score / 6)) : 0;
  confidence *= 0.6 ** unknownTerms.length; // out-of-vocabulary guard
  return { terms, expanded, unknownTerms, results: top, confidence: +confidence.toFixed(3), question };
}

// ---------------------------------------------------------------------------
// Extractive answer composition (demo mode + highlight source for live mode)
// ---------------------------------------------------------------------------
export function plain(md) {
  return md
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// Break a chunk into answerable units: sentences, bullet items, table rows
// (rewritten as "Header: value; …" so they read as sentences).
export function units(text) {
  const out = [];
  const lines = text.split('\n');
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { header = null; continue; }
    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!header) { header = cells; continue; }
      const sent = cells.map((c, j) => (j === 0 ? c : `${header[j] || ''}: ${c}`)).join(' — ');
      out.push({ text: plain(sent), raw: line });
      continue;
    }
    const item = line.replace(/^(\d+\.|[-*])\s+/, '');
    const parts = plain(item).split(/(?<=[.!?])\s+(?=[A-Z"(])/);
    for (const p of parts) if (words(p).length >= 3) out.push({ text: p.trim(), raw: line });
  }
  return out;
}

const QUANTITY = /\b(how (many|much|long|fast|quickly|soon|often)|when|deadline|limit|cost|price|within)\b/i;

const WHO = /^\s*(who|which team|whom)\b/i;
const ROLE = /\b(approver|manager|head|director|cfo|commander|owner|team|lead|csm|engineer|on-call)\b/i;

// If the question names an amount ("$2,000", "25%"), prefer the rule whose
// range contains it: "Up to $500", "$500 – $5,000", "15–30%", "above 30%".
function amountIn(text) {
  const m = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?%/);
  if (!m) return null;
  return m[1] ? { kind: '$', v: +m[1].replace(/,/g, '') } : { kind: '%', v: +m[2] };
}
function rangeContains(text, amt) {
  const num = amt.kind === '$' ? '\\$\\s?(\\d[\\d,]*)' : '(\\d+(?:\\.\\d+)?)\\s?%?';
  const n = (x) => +x.replace(/,/g, '');
  const t = text.replace(/\s+/g, ' ');
  let m = t.match(new RegExp(`${num}\\s?[–-]\\s?${num}${amt.kind === '%' ? '%' : ''}`));
  if (m) return amt.v >= n(m[1]) && amt.v <= n(m[2]);
  m = t.match(new RegExp(`(?:up to|under|below|less than)\\s${num}`, 'i'));
  if (m && amt.v <= n(m[1])) return true;
  m = t.match(new RegExp(`(?:over|above|more than|exceed)\\s${num}`, 'i'));
  if (m && amt.v > n(m[1])) return true;
  return false;
}

// Lightweight answer-type detection: "how many/long…" wants a number,
// "who…" wants a role. Matching units get a boost.
export function pickSentences(index, search, max = 4) {
  const { terms, expanded, results } = search;
  if (!results.length) return [];
  const wantsNumber = QUANTITY.test(search.question || '');
  const wantsRole = WHO.test(search.question || '');
  const amount = amountIn(search.question || '');
  const idf = (t) => index.idf.get(t) || 0;
  const floor = results[0].score * 0.45;
  const cands = [];
  results.forEach((r, rank) => {
    if (r.score < floor) return;
    // Terms matched by the section heading lend context to every sentence in it
    // ("Parental leave" → "Primary caregivers: 26 weeks fully paid").
    const headToks = new Set(tokenize(`${r.section}`));
    units(r.text).forEach((u, pos) => {
      const toks = new Set(tokenize(u.text));
      let s = 0;
      let direct = 0;
      for (const t of terms) {
        if (toks.has(t)) { s += idf(t); direct++; } else if (headToks.has(t)) s += 0.55 * idf(t);
      }
      for (const t of expanded) if (toks.has(t)) s += 0.4 * idf(t);
      if (s <= 0) return;
      if (wantsNumber && /\d/.test(u.text)) s *= 1.3;
      if (wantsRole && ROLE.test(u.text)) s *= 1.35;
      if (amount && rangeContains(u.text, amount)) s *= 1.6;
      s *= (1 - rank * 0.15) * (1 - Math.min(pos, 6) * 0.025);
      if (words(u.text).length > 45) s *= 0.85;
      cands.push({ ...u, n: rank + 1, pos, chunkId: r.id, score: s, direct });
    });
  });
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0]?.score || 0;
  // Lead with the top-ranked chunk when it has a competitive sentence.
  const leadIdx = cands.findIndex((c) => c.n === 1 && c.score >= best * 0.7);
  if (leadIdx > 0) cands.unshift(...cands.splice(leadIdx, 1));
  const picked = [];
  for (const c of cands) {
    if (picked.length >= max) break;
    const sameChunk = picked.length && c.n === picked[0].n;
    if (c.score < best * (sameChunk || !picked.length ? 0.4 : 0.58)) continue;
    if (picked.some((p) => p.text === c.text)) continue;
    picked.push(c);
  }
  // Keep the lead; read the supporting facts in document order.
  const [lead, ...rest] = picked;
  return lead ? [lead, ...rest.sort((a, b) => a.n - b.n || a.pos - b.pos)] : [];
}

export function composeExtractive(picked) {
  if (!picked.length) return '';
  const [lead, ...rest] = picked;
  const cite = (p) => `[${p.n}]`;
  let out = `${lead.text.replace(/\s*$/, '')} ${cite(lead)}`;
  if (rest.length) {
    out += '\n\nRelated details from the docs:\n' + rest.map((p) => `- ${p.text} ${cite(p)}`).join('\n');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knowledge base (built once per cold start, cached in module scope)
// ---------------------------------------------------------------------------
let KB = null;

export function kbDir() {
  const candidates = [join(process.cwd(), 'kb'), join(HERE, '..', 'kb')];
  for (const c of candidates) {
    try { readdirSync(c); return c; } catch { /* try next */ }
  }
  throw new Error('Knowledge base folder /kb not found');
}

export function loadKB() {
  if (KB) return KB;
  const t0 = performance.now();
  const dir = kbDir();
  const docs = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => makeDoc(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')));
  const chunks = docs.flatMap(chunkDoc);
  for (const d of docs) d.chunks = chunks.filter((c) => c.docId === d.id).length;
  const index = buildIndex(chunks);
  KB = { docs, chunks, index, builtAt: new Date().toISOString(), buildMs: +(performance.now() - t0).toFixed(1) };
  return KB;
}
