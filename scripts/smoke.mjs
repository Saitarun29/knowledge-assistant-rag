// Smoke test: node scripts/smoke.mjs  — calls the API handlers with mock req/res (demo mode).
import ask from '../api/ask.js';
import docs from '../api/docs.js';

function call(handler, { method = 'POST', body, url = '/' } = {}) {
  return new Promise((resolve) => {
    const req = { method, body, url, headers: {}, socket: {} };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      end(s) { resolve({ status: this.statusCode, json: s ? JSON.parse(s) : null }); } };
    handler(req, res);
  });
}

const questions = process.argv.slice(2).length ? process.argv.slice(2) : [
  'How many vacation days do I get per year?',
  'Can I carry over unused leave?',
  'What is the hotel limit when travelling to London?',
  'Who approves an expense of $2,000?',
  'What should I do if I lose my laptop?',
  'How fast do we respond to a SEV1 incident?',
  'How much does the Business plan cost?',
  'What discount can a sales rep give without approval?',
  'Where is customer data hosted?',
  'What happens on my first day?',
  'How long is parental leave?',
  'Can I paste customer data into ChatGPT?',
  'What is the uptime SLA for enterprise?',
  'How do I handle the objection that we already use Zapier?',
  'Do we offer dental insurance?',
  'What is the capital of France?',
  'Who won the cricket world cup?',
  'What is the office wifi password?',
  'Is there a gym membership benefit?',
];
for (const q of questions) {
  const r = await call(ask, { body: { question: q } });
  const j = r.json;
  console.log(`\n### ${q}\n[${j.mode}] found=${j.found} conf=${j.debug.confidence} top=${j.chunks.slice(0,3).map(c=>`${c.id}:${c.score}/${c.coverage}`).join(' ')} ${j.debug.latency.totalMs}ms`);
  console.log(j.answer);
}
const user = await call(ask, { body: { question: 'What is the wifi password for guests?', userDoc: { title: 'Office guide', text: 'Guest WiFi\n\nThe guest WiFi network is NW-Guest and the password is changed monthly; ask reception for the current password. The office opens at 8am.' } } });
console.log('\n### userDoc test\n', user.json.found, user.json.answer, user.json.debug.userDoc);
const list = await call(docs, { method: 'GET', url: '/api/docs' });
console.log('\n### docs', list.status, list.json.stats, list.json.docs.map(d=>d.id+':'+d.chunks).join(', '));
const one = await call(docs, { method: 'GET', url: '/api/docs?id=pricing' });
console.log('### doc pricing', one.status, one.json.title, one.json.chunkList.length);
const bad = await call(ask, { body: { question: 'x' } });
console.log('### bad', bad.status, bad.json);
