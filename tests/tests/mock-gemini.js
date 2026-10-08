'use strict';
// خادم Gemini تجريبي محلي للاختبار بدون إنترنت. يحاكي شكل الطلب والاستجابة الموثقين لـ generateContent.
// التحكم: POST /__mode {mode, delay}  |  GET /__calls  |  POST /__reset
const http = require('node:http');
const KEY = 'test-key-SECRET';
const state = { mode: 'ok', delay: 0, calls: [] };
const ok = o => ({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(o) }] }, finishReason: 'STOP' }] });
const leaf = (title, type = 'feature') => ({ title, description: 'وصف ' + title, type });
function mapTree(prompt) {
  const t = (prompt.match(/Title: (.*)/) || [])[1] || 'فكرة';
  return { root: { title: t, description: 'ملخص ' + t, type: 'idea', children: [
    { ...leaf('الجمهور', 'audience'), children: [leaf('الشباب', 'audience'), leaf('الطلاب', 'audience')].map(c => ({ ...c, children: [] })) },
    { ...leaf('المميزات', 'feature'), children: [leaf('دروس'), leaf('ألعاب'), leaf('تحديات')].map(c => ({ ...c, children: c.title === 'ألعاب' ? [leaf('ألغاز', 'feature')] : [] })) },
    { ...leaf('المنافسون', 'competitor'), children: [] },
    { ...leaf('الأهداف', 'goal'), children: [leaf('أول ١٠٠ مستخدم', 'goal')].map(c => ({ ...c, children: [] })) },
    { ...leaf('الجمهور', 'audience'), children: [] },               // مكرر عمدًا: يجب إسقاطه
  ] } };
}
const expandTree = () => ({ children: [
  { ...leaf('إنستغرام', 'feature'), children: [leaf('ريلز', 'task')].map(c => ({ ...c, children: [] })) },
  { ...leaf('تيك توك', 'feature'), children: [] }, { ...leaf('المؤثرون', 'feature'), children: [] }, { ...leaf('العروض', 'feature'), children: [] } ] });
const bad = {
  badjson: { candidates: [{ content: { parts: [{ text: '{"root": {oops' }] }, finishReason: 'STOP' }] },
  badtype: ok({ root: { title: 'x', description: 'y', type: 'evil', children: [] } }),
  missingtitle: ok({ root: { description: 'y', type: 'idea', children: [] } }),
  noroot: ok({ hello: 1 }), nokids: ok({ root: { title: 'x', description: '', type: 'idea', children: [] } }),
  empty: { candidates: [] }, nocontent: { candidates: [{ finishReason: 'STOP' }] },
  blocked: { promptFeedback: { blockReason: 'SAFETY' } }, safety: { candidates: [{ finishReason: 'SAFETY' }] },
  maxtokens: { candidates: [{ content: { parts: [{ text: '{"root"' }] }, finishReason: 'MAX_TOKENS' }] },
};
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', async () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/__mode') { Object.assign(state, JSON.parse(b || '{}')); return send(200, { ok: true }); }
    if (req.url === '/__reset') { state.mode = 'ok'; state.delay = 0; state.calls = []; return send(200, { ok: true }); }
    if (req.url === '/__calls') return send(200, state.calls);
    const m = req.url.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
    if (!m || req.method !== 'POST') return send(404, { error: { status: 'NOT_FOUND', message: 'no' } });
    if (req.headers['x-goog-api-key'] !== KEY) return send(403, { error: { status: 'PERMISSION_DENIED', message: 'API key not valid: ' + req.headers['x-goog-api-key'] } });
    const body = JSON.parse(b); state.calls.push({ model: m[1], body });
    if (state.delay) await new Promise(r => setTimeout(r, state.delay));
    const prompt = body.contents?.[0]?.parts?.[0]?.text || '', isMap = !!body.generationConfig?.responseJsonSchema?.properties?.root;
    switch (state.mode) {
      case 'ok': return send(200, ok(isMap ? mapTree(prompt) : expandTree()));
      case 'http429': return send(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } });
      case 'http500': return send(500, { error: { status: 'INTERNAL', message: 'boom ' + req.headers['x-goog-api-key'] } });
      case 'http400': return send(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad schema' } });
      default: return send(200, bad[state.mode] || ok({}));
    }
  });
});
if (require.main === module) srv.listen(+process.argv[2] || 3300, '127.0.0.1', () => console.log('mock gemini up'));
module.exports = { srv, KEY };
