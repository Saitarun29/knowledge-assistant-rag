// Internal Knowledge Assistant — front-end (vanilla JS, no build step).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const SUGGESTED = [
  { q: 'How many vacation days do I get per year?' },
  { q: 'Who approves an expense of $2,000?' },
  { q: 'What should I do if I lose my laptop?' },
  { q: 'How fast do we respond to a SEV1 incident?' },
  { q: 'What discount can a sales rep give without approval?' },
  { q: 'Where is customer data hosted?' },
  { q: 'Do we offer dental insurance?', off: true, title: 'Not in the docs — watch it refuse instead of guessing' },
];

const FOLLOWUPS = {
  'hr-leave-policy': ['Can I carry over unused leave?', 'How long is parental leave?', 'When do I need a medical certificate?'],
  'expense-policy': ['What is the hotel limit in London?', 'When do I get reimbursed?', 'What is the home office stipend?'],
  'onboarding-guide': ['What happens on my first day?', 'Which courses must I finish in week one?', 'How long is probation?'],
  'security-policy': ['Can I paste customer data into ChatGPT?', 'How do I report phishing?', 'How long must passwords be?'],
  'product-faq': ['What is the uptime SLA for Enterprise?', 'What is the API rate limit?', 'Is there a free trial?'],
  pricing: ['How much does the Business plan cost?', 'Can annual plans be refunded?', 'What is the overage price on Business?'],
  'incident-runbook': ['How do I declare an incident?', 'When is a postmortem required?', 'How do I roll back a deploy?'],
  'sales-playbook': ['How fast must inbound leads be contacted?', 'How do I handle "we already use Zapier"?', 'What commission do AEs earn?'],
};

// Two-letter monochrome tags for documents (no icons/emoji).
const DOC_TAGS = {
  'hr-leave-policy': 'HR', 'expense-policy': 'FN', 'onboarding-guide': 'ON', 'security-policy': 'SC',
  'product-faq': 'PR', pricing: 'PX', 'incident-runbook': 'IR', 'sales-playbook': 'SL', 'user-doc': 'TM',
};
const tag = (id) => `<span class="doc-tag" aria-hidden="true">${DOC_TAGS[id] || 'DC'}</span>`;

const SAMPLE_DOC = {
  title: 'Hyderabad Office Guide',
  text: `# Hyderabad Office Guide

## Getting in
The Hyderabad hub is on the 9th floor of Skyview Tower, HITEC City. Doors open at 8:00 and close at 21:00 on weekdays. Use your NFC badge at the turnstiles; visitors must be registered in Envoy by their host the day before.

## Guest WiFi
The guest network is NW-Guest. The password rotates every Monday and is printed on the reception desk card. Employees should use NW-Corp, which signs in with Okta.

## Food
The cafeteria serves breakfast 8:30–10:30 and lunch 12:30–14:30. Lunch is free on Tuesdays and Thursdays (team days). Snacks and coffee are available all day on the pantry wall.

## Parking
Two-wheeler parking is free in basement B1. Car parking is limited to 12 reserved spots — request one in #hyd-facilities at least 2 days ahead.`,
};

const LIMIT = 20000;
const state = { history: [], docs: [], activeMsg: null, activeCite: null, busy: false, docCache: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

// Same light stemmer as the server (lib/rag.js) so highlights line up.
function stem(w) {
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
const norm = (s) => String(s).toLowerCase().replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();

// Minimal, safe markdown renderer (headings, lists, tables, paragraphs).
function renderMarkdown(md) {
  const lines = String(md).replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { const l = Math.min(h[1].length, 3); html += `<h${l}>${inline(h[2])}</h${l}>`; i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      html += '<table><thead><tr>' + cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      html += body.slice(1).map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('');
      html += '</tbody></table>';
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      html += `<${ordered ? 'ol' : 'ul'}>` + items.map((it) => `<li>${inline(it)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    html += `<p>${inline(para.join(' '))}</p>`;
  }
  return html;
}

// Highlight cited sentences (block level) and matched query terms (word level).
function applyHighlights(root, sentences = [], terms = []) {
  if (sentences.length) {
    const keys = sentences.map((s) => norm(s.split(' — ')[0]));
    for (const el of $$('p, li, tr', root)) {
      const text = norm(el.textContent);
      const first = el.tagName === 'TR' ? norm(el.firstElementChild?.textContent || '') : null;
      if (keys.some((k) => (first !== null ? first === k : k.length >= 10 && text.includes(k.slice(0, 80))))) el.classList.add('hl');
    }
  }
  const set = new Set(terms);
  if (!set.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.nodeValue.split(/([A-Za-z0-9][A-Za-z0-9\-$%.']*[A-Za-z0-9%]|[A-Za-z0-9])/);
    if (parts.length < 2) continue;
    let changed = false;
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      const w = p.toLowerCase().replace(/[.']/g, '');
      const hit = p && /[A-Za-z0-9]/.test(p) && (set.has(stem(w)) || w.split('-').some((x) => x.length > 1 && set.has(stem(x))));
      if (hit) { const m = document.createElement('mark'); m.textContent = p; frag.appendChild(m); changed = true; }
      else frag.appendChild(document.createTextNode(p));
    }
    if (changed) node.parentNode.replaceChild(frag, node);
  }
}

function setMode(mode) {
  const b = $('#modeBadge');
  b.className = `badge ${mode === 'live' ? 'badge-live' : 'badge-demo'}`;
  b.querySelector('b').textContent = mode === 'live' ? 'Live' : 'Demo data';
  b.title = mode === 'live'
    ? 'Answers are generated by Gemini, grounded in the retrieved chunks'
    : 'No API key configured. Answers are composed extractively from the retrieved chunks, without an LLM';
}

// ---------------------------------------------------------------------------
// Knowledge base panel
// ---------------------------------------------------------------------------
function userDoc() {
  const text = $('#userDocText').value.trim();
  if (!text) return null;
  return { title: $('#userDocTitle').value.trim() || 'Your pasted document', text: text.slice(0, LIMIT) };
}

function renderDocList() {
  const list = $('#docList');
  const ud = userDoc();
  const items = state.docs.map((d) => `
    <li><button type="button" class="doc-item" data-doc="${esc(d.id)}">
      ${tag(d.id)}
      <span class="doc-meta"><b>${esc(d.title)}</b><small>${esc(d.owner)} · ${d.chunks} chunks · ${d.words} words</small></span>
    </button></li>`);
  if (ud) {
    items.push(`<li><button type="button" class="doc-item user" data-doc="user-doc">
      ${tag('user-doc')}
      <span class="doc-meta"><b>${esc(ud.title)}</b><small>Temporary · ${ud.text.length.toLocaleString()} chars · this session only</small></span>
    </button></li>`);
  }
  list.innerHTML = items.join('');
}

function syncUserDoc() {
  const len = $('#userDocText').value.length;
  const c = $('#userDocCount');
  c.textContent = `${len.toLocaleString()} / ${LIMIT.toLocaleString()}`;
  c.classList.toggle('warn', len > LIMIT * 0.9);
  const on = !!userDoc();
  const st = $('#userDocState');
  st.textContent = on ? 'Included' : 'Off';
  st.className = `pill ${on ? 'ok' : 'soft'}`;
  $('#userDocFlag').hidden = !on;
  try {
    sessionStorage.setItem('kar-userdoc', JSON.stringify({ title: $('#userDocTitle').value, text: $('#userDocText').value }));
  } catch { /* storage unavailable */ }
  renderDocList();
  renderSuggestions();
}

async function loadDocs() {
  try {
    const r = await fetch('/api/docs');
    if (!r.ok) throw new Error(r.statusText);
    const data = await r.json();
    state.docs = data.docs;
    $('#kbStats').textContent = `${data.stats.docs} docs · ${data.stats.chunks} chunks`;
    setMode(data.mode);
    renderDocList();
  } catch {
    $('#docList').innerHTML = '<li class="error-row" role="alert">Couldn\'t load the document list. Run <code>npx vercel dev</code> or <code>npm run dev</code> so the API is available.</li>';
    $('#kbStats').textContent = 'offline';
    const b = $('#modeBadge');
    b.className = 'badge badge-bad';
    b.querySelector('b').textContent = 'API offline';
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function renderSuggestions() {
  const box = $('#suggest');
  if (!box) return;
  const list = [...SUGGESTED];
  if (userDoc()) list.unshift({ q: /wifi/i.test($('#userDocText').value) ? 'What is the guest WiFi network?' : `Summarise "${userDoc().title}"` });
  box.innerHTML = list.map((s) => `<button type="button" class="chip${s.off ? ' off' : ''}" data-q="${esc(s.q)}" ${s.title ? `title="${esc(s.title)}"` : ''}>${esc(s.q)}</button>`).join('');
}

const BOT_AVATAR = '<div class="avatar" aria-hidden="true">KA</div>';

function renderAnswerText(text, idx) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  const cites = (s) => inline(s).replace(/\[(\d+)\]/g, (_, n) => `<button type="button" class="cite" data-msg="${idx}" data-n="${n}" aria-label="Source ${n}">${n}</button>`);
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${cites(line.replace(/^[-*]\s+/, ''))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (!line) continue;
    if (/:$/.test(line) && line.length < 60) html += `<p class="sub-h">${esc(line)}</p>`;
    else html += `<p>${cites(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function addUser(q) {
  $('#welcome')?.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${esc(q)}</div>`;
  $('#messages').appendChild(el);
}

function addTyping() {
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.innerHTML = `${BOT_AVATAR}<div class="bubble"><span class="loading" role="status"><span class="spin" aria-hidden="true"></span>Searching documents</span></div>`;
  $('#messages').appendChild(el);
  scrollDown();
  return el;
}

function scrollDown() {
  const m = $('#messages');
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

function renderBot(el, res, idx) {
  el.className = `msg bot${res.found ? '' : ' notfound'}`;
  const conf = res.debug.confidence;
  const confColor = conf >= 0.6 ? 'var(--ok)' : conf >= res.debug.threshold ? 'var(--ink-2)' : 'var(--warn)';
  const sources = res.citations.map((c) => `
    <button type="button" class="src-chip" data-msg="${idx}" data-n="${c.n}" title="${esc(c.docTitle)} › ${esc(c.section)}">
      <span class="n">${c.n}</span><span>${esc(c.docTitle)} › ${esc(c.section)}</span>
    </button>`).join('');
  const topDoc = res.citations[0]?.docId;
  const asked = new Set(state.history.map((h) => h.q.toLowerCase()));
  const follow = (FOLLOWUPS[topDoc] || []).filter((q) => !asked.has(q.toLowerCase())).slice(0, 2);
  el.innerHTML = `${BOT_AVATAR}<div class="bubble">
    ${res.found ? '' : '<div class="notfound-tag">Not in the documents</div>'}
    <div class="answer">${renderAnswerText(res.answer, idx)}</div>
    ${sources ? `<div class="sources">${sources}</div>` : ''}
    <div class="meta-row">
      <span class="conf" title="Retrieval confidence (threshold ${res.debug.threshold})"><i style="--w:${Math.round(conf * 100)}%;--c:${confColor}"></i>${Math.round(conf * 100)}% match</span>
      <span>·</span><span>${res.debug.latency.totalMs} ms</span>
      <span>·</span><span>${res.mode === 'live' ? 'Gemini' : 'Extractive'}</span>
      <span>·</span><button type="button" class="link" data-debug="${idx}">Inspect retrieval</button>
    </div>
    ${follow.length ? `<div class="followups">${follow.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
  </div>`;
  scrollDown();
}

async function ask(q) {
  q = q.trim();
  if (!q || state.busy) return;
  if (q.length > 500) q = q.slice(0, 500);
  state.busy = true;
  $('#sendBtn').disabled = true;
  addUser(q);
  const typing = addTyping();
  const idx = state.history.length;
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, userDoc: userDoc() }),
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || `Request failed (${r.status})`);
    state.history.push({ q, res });
    setMode(res.mode);
    renderBot(typing, res, idx);
    showDebug(idx, { reveal: false });
  } catch (err) {
    typing.className = 'msg bot notfound';
    typing.innerHTML = `${BOT_AVATAR}<div class="bubble"><div class="notfound-tag bad">Request failed</div><p style="margin:0">${esc(err.message || 'Network error')}. Check your connection and ask again.</p></div>`;
  } finally {
    state.busy = false;
    $('#sendBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Side panel: source viewer + retrieval debug
// ---------------------------------------------------------------------------
function switchTab(tab) {
  for (const t of $$('.tab')) {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  }
  $('#pane-source').hidden = tab !== 'source';
  $('#pane-debug').hidden = tab !== 'debug';
  $('.side-body').scrollTop = 0;
}

const isSheet = () => window.matchMedia('(max-width: 960px)').matches;
function openSide() {
  if (!isSheet()) return;
  $('#sidePanel').classList.add('open');
  $('#scrim').hidden = false;
}
function closeOverlays() {
  $('#sidePanel').classList.remove('open');
  $('#leftCol').classList.remove('open');
  $('#scrim').hidden = true;
}

function markActive(idx, n) {
  for (const c of $$('.cite[data-msg], .src-chip')) c.classList.toggle('active', +c.dataset.msg === idx && +c.dataset.n === n);
  for (const d of $$('.doc-item')) d.classList.remove('active');
}

async function fetchDoc(id) {
  if (id === 'user-doc') { const ud = userDoc(); return ud ? { id, title: ud.title, body: ud.text, owner: 'You', updated: 'now' } : null; }
  if (state.docCache[id]) return state.docCache[id];
  const r = await fetch(`/api/docs?id=${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return (state.docCache[id] = await r.json());
}

function showSource(idx, n) {
  const h = state.history[idx];
  if (!h) return;
  const chunk = h.res.chunks.find((c) => c.n === n);
  if (!chunk) return;
  state.activeMsg = idx;
  state.activeCite = n;
  markActive(idx, n);
  const cited = new Set(h.res.citations.map((c) => c.n));
  const pane = $('#pane-source');
  pane.innerHTML = `
    <div class="src-head">
      <div class="crumbs"><span>${esc(chunk.docTitle)}</span><span>›</span><span>${esc(chunk.section)}</span></div>
      <h3>Source [${n}]${chunk.user ? ' · your temporary doc' : ''}</h3>
      <div class="src-tags">
        <span class="pill soft">BM25 ${chunk.score}</span>
        <span class="pill soft">coverage ${Math.round(chunk.coverage * 100)}%</span>
        <span class="pill soft">${esc(chunk.id)}</span>
      </div>
    </div>
    <div class="chunk-nav" aria-label="Retrieved chunks">
      ${h.res.chunks.map((c) => `<button type="button" class="cite${c.n === n ? ' active' : ''}" data-msg="${idx}" data-n="${c.n}" title="${esc(c.docTitle)} › ${esc(c.section)}${cited.has(c.n) ? ' (cited)' : ''}" ${cited.has(c.n) ? '' : ' data-uncited'}>${c.n}</button>`).join('')}
    </div>
    <div class="chunk-box">
      <div class="chunk-label"><span>Retrieved passage</span><span>${chunk.matchedTerms.length} matched terms</span></div>
      <div class="md" id="chunkMd">${renderMarkdown(`## ${chunk.section}\n\n${chunk.text}`)}</div>
    </div>
    <details class="full-doc" id="fullDoc"><summary>Open full document</summary><div class="md" id="fullDocMd"><p class="muted">Loading…</p></div></details>`;
  applyHighlights($('#chunkMd'), h.res.highlights[n] || [], chunk.matchedTerms);
  $('#fullDoc').addEventListener('toggle', async (e) => {
    if (!e.target.open || e.target.dataset.loaded) return;
    const doc = await fetchDoc(chunk.docId);
    const box = $('#fullDocMd');
    if (!doc) { box.innerHTML = '<p class="muted">Document unavailable.</p>'; return; }
    box.innerHTML = renderMarkdown(doc.body);
    applyHighlights(box, h.res.highlights[n] || [], chunk.matchedTerms);
    e.target.dataset.loaded = '1';
  }, { once: false });
  switchTab('source');
  openSide();
}

async function showDoc(id) {
  for (const d of $$('.doc-item')) d.classList.toggle('active', d.dataset.doc === id);
  const pane = $('#pane-source');
  pane.innerHTML = '<p class="muted">Loading…</p>';
  switchTab('source');
  closeOverlays();
  openSide();
  const doc = await fetchDoc(id);
  if (!doc) { pane.innerHTML = '<p class="muted">Document unavailable.</p>'; return; }
  pane.innerHTML = `
    <div class="src-head">
      <div class="crumbs"><span>Knowledge base</span></div>
      <h3>${esc(doc.title)}</h3>
      <div class="src-tags">
        <span class="pill soft">Owner: ${esc(doc.owner)}</span>
        ${doc.updated ? `<span class="pill soft">Updated ${esc(doc.updated)}</span>` : ''}
        ${doc.chunkList ? `<span class="pill soft">${doc.chunkList.length} chunks</span>` : '<span class="pill ok">Temporary</span>'}
      </div>
    </div>
    <div class="md">${renderMarkdown(doc.body)}</div>`;
}

function showDebug(idx, { reveal = true } = {}) {
  const h = state.history[idx];
  if (!h) return;
  const { res, q } = h;
  const d = res.debug;
  const maxScore = Math.max(...res.chunks.map((c) => c.score), 1);
  const cited = new Set(res.citations.map((c) => c.n));
  const lat = d.latency;
  const other = Math.max(lat.totalMs - lat.retrievalMs - lat.generationMs, 0);
  const pct = (v) => `${Math.max((v / Math.max(lat.totalMs, 0.001)) * 100, v > 0 ? 3 : 0)}%`;
  const confOk = d.confidence >= d.threshold;
  $('#pane-debug').innerHTML = `
    <p class="dbg-q">Question: <b>${esc(q)}</b></p>
    <div class="stat-grid">
      <div class="stat"><small>Confidence</small><b class="${confOk ? 'ok' : 'low'}">${Math.round(d.confidence * 100)}%</b></div>
      <div class="stat"><small>Latency</small><b>${lat.totalMs}<span class="unit"> ms</span></b></div>
      <div class="stat"><small>Searched</small><b>${d.index.chunks}<span class="unit"> chunks</span></b></div>
    </div>
    <div class="lat" title="Latency breakdown"><i class="r" style="width:${pct(lat.retrievalMs)}"></i><i class="g" style="width:${pct(lat.generationMs)}"></i><i class="o" style="width:${pct(other)}"></i></div>
    <div class="lat-legend"><span style="--c:var(--ink)">Retrieval ${lat.retrievalMs} ms</span><span style="--c:var(--muted)">Generation ${lat.generationMs} ms</span><span style="--c:var(--line-2)">Other ${other.toFixed(1)} ms</span></div>

    <div class="dbg-label">Query terms</div>
    <div class="terms">
      ${d.queryTerms.map((t) => `<span class="term${d.unknownTerms?.includes(t) ? ' unk' : ''}" title="${d.unknownTerms?.includes(t) ? 'Not in the knowledge base vocabulary' : 'Query term (stemmed)'}">${esc(t)}</span>`).join('')}
      ${d.expandedTerms.map((t) => `<span class="term exp" title="Added by synonym expansion">+${esc(t)}</span>`).join('')}
    </div>

    <div class="dbg-label">Top ${res.chunks.length} chunks · ${confOk ? 'answer grounded' : 'below threshold → refused'}</div>
    ${res.chunks.length ? res.chunks.map((c) => `
      <div class="rank${cited.has(c.n) ? ' cited' : ''}" data-msg="${idx}" data-n="${c.n}" role="button" tabindex="0">
        <div class="rank-top"><span class="n">${c.n}</span><b>${esc(c.docTitle)} › ${esc(c.section)}</b><code>${c.score.toFixed(2)}</code></div>
        <div class="bar"><i data-w="${(c.score / maxScore) * 100}"></i></div>
        <p>${esc(c.text.replace(/[#*|`]/g, ' ').replace(/\s+/g, ' ').slice(0, 180))}…</p>
      </div>`).join('') : '<p class="muted" style="font-size:13px">No chunk shared a single term with the question.</p>'}

    <div class="dbg-label">Pipeline</div>
    <div class="kv">
      ranker: <b>${esc(d.ranker)}</b><br>
      generator: <b>${esc(d.generator)}</b><br>
      threshold: <b>${d.threshold}</b> · top_k: <b>${d.topK}</b><br>
      index: <b>${d.index.docs} docs, ${d.index.chunks} chunks, ${d.index.vocabulary} terms</b><br>
      index build: <b>${d.index.buildMs} ms</b> (cold start${d.index.coldStart ? ' — this request' : ', cached'})
      ${d.userDoc ? `<br>temp doc: <b>${esc(d.userDoc.title)} → ${d.userDoc.chunks} chunks${d.userDoc.truncated ? ' (truncated)' : ''}</b>` : ''}
    </div>`;
  requestAnimationFrame(() => { for (const b of $$('#pane-debug .bar i')) b.style.width = `${b.dataset.w}%`; });
  if (reveal) { switchTab('debug'); openSide(); }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]');
  if (q) { closeOverlays(); ask(q.dataset.q); return; }
  const cite = e.target.closest('.cite[data-msg], .src-chip, .rank');
  if (cite) { showSource(+cite.dataset.msg, +cite.dataset.n); return; }
  const dbg = e.target.closest('[data-debug]');
  if (dbg) { showDebug(+dbg.dataset.debug); return; }
  const doc = e.target.closest('.doc-item');
  if (doc) { showDoc(doc.dataset.doc); return; }
  const tab = e.target.closest('.tab');
  if (tab) switchTab(tab.dataset.tab);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlays();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('rank')) { e.preventDefault(); e.target.click(); }
});

const qBox = $('#q');
qBox.addEventListener('input', () => { qBox.style.height = 'auto'; qBox.style.height = `${Math.min(qBox.scrollHeight, 140)}px`; });
qBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = qBox.value;
  if (!v.trim()) return;
  qBox.value = '';
  qBox.style.height = 'auto';
  ask(v);
});

$('#newChat').addEventListener('click', () => {
  state.history = [];
  $('#messages').innerHTML = `<div class="welcome" id="welcome">
    <h3>Ask about leave, expenses, security, pricing or incidents</h3>
    <p>Each answer cites the passages it used. Select a citation to read the source, or open Retrieval to see how it was ranked.</p>
    <div class="suggest" id="suggest" role="group" aria-label="Example questions"></div></div>`;
  renderSuggestions();
  $('#pane-debug').innerHTML = '<div class="empty"><p class="empty-title">No query yet</p><p>Ask a question to see retrieved chunks, BM25 scores, confidence and latency.</p></div>';
  qBox.focus();
});

$('#openDocs').addEventListener('click', () => { $('#leftCol').classList.add('open'); $('#scrim').hidden = false; });
$('#closeSide').addEventListener('click', closeOverlays);
$('#scrim').addEventListener('click', closeOverlays);

let t;
for (const id of ['#userDocText', '#userDocTitle']) $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(syncUserDoc, 150); });
$('#sampleDoc').addEventListener('click', () => { $('#userDocTitle').value = SAMPLE_DOC.title; $('#userDocText').value = SAMPLE_DOC.text; syncUserDoc(); });
$('#clearDoc').addEventListener('click', () => { $('#userDocTitle').value = ''; $('#userDocText').value = ''; syncUserDoc(); });

try {
  const saved = JSON.parse(sessionStorage.getItem('kar-userdoc') || 'null');
  if (saved) { $('#userDocTitle').value = saved.title || ''; $('#userDocText').value = saved.text || ''; }
} catch { /* ignore */ }

renderSuggestions();
syncUserDoc();
loadDocs();
