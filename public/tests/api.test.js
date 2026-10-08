'use strict';
// اختبارات الخادم: المصادقة، الملكية، التحقق، سلامة العلاقات. تشغيل: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');

const PORT = 3200 + Math.floor(Math.random() * 500), BASE = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(os.tmpdir(), `fikra-test-${process.pid}.db`);
let srv;
before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server/index.js')],
    { env: { ...process.env, PORT: String(PORT), DATABASE_PATH: dbFile, HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch (e) { /* انتظر */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('الخادم لم يبدأ');
});
after(() => { srv.kill(); for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true }); });

async function call(method, url, body, jar) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Fikra': '1', ...(jar?.c ? { Cookie: jar.c } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc && jar) jar.c = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) { /* فارغ */ }
  return { s: r.status, j, h: r.headers };
}
const mkUser = async (name) => { const jar = {}; const r = await call('POST', '/api/auth/register', { name, email: `${name}${Math.random().toString(36).slice(2, 6)}@t.com`, password: '12345678' }, jar); assert.equal(r.s, 201); return { jar, id: r.j.user.id }; };
const now = Date.now();
const idea = (id, extra = {}) => ({ id, title: 'فكرة ' + id, body: '', status: 'new', priority: 'medium', progress: 0, createdAt: now, updatedAt: now, ...extra });
const node = (id, parentId, extra = {}) => ({ id, mindMapId: 'mm1', parentId, title: 'عقدة ' + id, description: '', notes: '', type: 'idea', positionX: 0, positionY: 0, color: 'def', icon: '', isCollapsed: false, isCompleted: false, order: 0, createdAt: now, updatedAt: now, ...extra });
const map = (id, nodes, conns = []) => ({ id, title: 'خريطة', description: '', manual: false, nodes, conns });

test('المصادقة: تسجيل، جلسة، خروج، رفض كلمة مرور خاطئة', async () => {
  const jar = {}, email = 'auth@t.com';
  assert.equal((await call('POST', '/api/auth/register', { name: 'أ', email, password: '123' }, jar)).s, 400);
  const r = await call('POST', '/api/auth/register', { name: 'أحمد', email, password: '12345678' }, jar);
  assert.equal(r.s, 201); assert.match(r.h.get('set-cookie'), /HttpOnly/); assert.match(r.h.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await call('POST', '/api/auth/register', { name: 'أحمد', email, password: '12345678' }, {})).s, 409);
  assert.equal((await call('GET', '/api/me', null, jar)).j.user.email, email);
  assert.equal((await call('POST', '/api/auth/login', { email, password: 'wrongpass1' }, {})).s, 401);
  assert.equal((await call('POST', '/api/auth/login', { email, password: '12345678' }, {})).s, 200);
  await call('POST', '/api/auth/logout', null, jar);
  assert.equal((await call('GET', '/api/me', null, jar)).j.user, null);
  assert.equal((await call('GET', '/api/data', null, jar)).s, 401);            // مسار محمي
});
test('الاستجابات لا تحتوي كلمات مرور أو هاش أو مفاتيح', async () => {
  const u = await mkUser('leak'), r = await call('GET', '/api/me', null, u.jar), t = JSON.stringify(r.j) + JSON.stringify((await call('GET', '/api/data', null, u.jar)).j);
  assert.ok(!/pw_hash|pw_salt|password|GEMINI|API_KEY/i.test(t));
});
test('CSRF: رفض الطلبات المعدِّلة بدون الترويسة المخصصة أو بأصل مختلف', async () => {
  assert.equal((await fetch(BASE + '/api/auth/guest', { method: 'POST' })).status, 403);
  assert.equal((await fetch(BASE + '/api/auth/guest', { method: 'POST', headers: { 'X-Fikra': '1', Origin: 'https://evil.example' } })).status, 403);
});
test('الملكية: مستخدم B لا يقرأ ولا يعدّل ولا يحذف أفكار وخرائط A', async () => {
  const A = await mkUser('A'), B = await mkUser('B');
  assert.equal((await call('PUT', '/api/ideas/ideaA0001', idea('ideaA0001'), A.jar)).s, 200);
  assert.equal((await call('PUT', '/api/maps/ideaA0001', map('mapA0001', [node('r0000001', null)]), A.jar)).s, 200);
  const d = (await call('GET', '/api/data', null, B.jar)).j; assert.equal(d.ideas.length, 0); assert.equal(d.maps.length, 0);
  assert.equal((await call('PUT', '/api/ideas/ideaA0001', idea('ideaA0001', { title: 'اختراق' }), B.jar)).s, 404);   // تعديل
  assert.equal((await call('PUT', '/api/maps/ideaA0001', map('mapB0001', [node('r0000002', null)]), B.jar)).s, 404);  // خريطة غيره
  await call('DELETE', '/api/ideas/ideaA0001', null, B.jar); await call('DELETE', '/api/maps/ideaA0001', null, B.jar);
  const a = (await call('GET', '/api/data', null, A.jar)).j;
  assert.equal(a.ideas[0].title, 'فكرة ideaA0001'); assert.equal(a.maps.length, 1);   // بقيت كما هي
});
test('التحقق: رفض الأفكار والعقد غير الصالحة', async () => {
  const U = await mkUser('val');
  const put = (b, id = 'idea0001') => call('PUT', '/api/ideas/' + id, b, U.jar);
  assert.equal((await put(idea('idea0001', { title: '' }))).s, 400);
  assert.equal((await put(idea('idea0002'), 'idea0001')).s, 400);                           // معرّف لا يطابق
  assert.equal((await put(idea('idea0001', { status: 'hacked' }))).s, 400);
  assert.equal((await put(idea('idea0001', { files: [{ name: 'x.exe', type: 'application/x-msdownload', data: 'data:application/x-msdownload;base64,AA==' }] }))).s, 400);
  assert.equal((await put(idea('idea0001', { files: [{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }] }))).s, 200);
  const m = (nodes, conns) => call('PUT', '/api/maps/idea0001', map('map00001', nodes, conns), U.jar);
  assert.equal((await m([])).s, 400);
  assert.equal((await m([node('n0000001', null), node('n0000002', null)])).s, 400);        // جذران
  assert.equal((await m([node('n0000001', null), node('n0000002', 'ghost001')])).s, 400);  // أب غير موجود
  assert.equal((await m([node('n0000001', 'n0000002'), node('n0000002', 'n0000001')])).s, 400); // حلقة/لا جذر
  assert.equal((await m([node('n0000001', null, { type: 'evil' })])).s, 400);
  assert.equal((await m([node('n0000001', null)], [{ id: 'c0000001', sourceNodeId: 'n0000001', targetNodeId: 'nope0001' }])).s, 400);
  assert.equal((await m([node('n0000001', null)])).s, 200);
  assert.equal((await call('PUT', '/api/maps/noidea001', map('map00002', [node('n0000003', null)]), U.jar)).s, 404);   // فكرة غير موجودة
  assert.equal((await call('PUT', '/api/kv/evil', {}, U.jar)).s, 404);
});
test('سلامة العلاقات: الحفظ كامل، والحذف يزيل الخريطة والعقد والارتباطات (لا بيانات يتيمة)', async () => {
  const U = await mkUser('int');
  await call('PUT', '/api/ideas/idea0010', idea('idea0010'), U.jar);
  const nodes = [node('root0001', null), node('kid00001', 'root0001', { positionX: -200.5 }), node('kid00002', 'kid00001')];
  assert.equal((await call('PUT', '/api/maps/idea0010', map('map00010', nodes, [{ id: 'cn000001', sourceNodeId: 'kid00002', targetNodeId: 'root0001', label: 'علاقة', createdAt: now }]), U.jar)).s, 200);
  let d = (await call('GET', '/api/data', null, U.jar)).j;
  assert.equal(d.maps[0].nodes.length, 3); assert.equal(d.maps[0].nodes[1].positionX, -200.5); assert.equal(d.maps[0].conns[0].label, 'علاقة'); assert.equal(d.maps[0].userId, U.id);
  // إعادة الحفظ تستبدل ولا تكرر
  await call('PUT', '/api/maps/idea0010', map('map00010', nodes.slice(0, 2)), U.jar);
  d = (await call('GET', '/api/data', null, U.jar)).j; assert.equal(d.maps[0].nodes.length, 2); assert.equal(d.maps[0].conns.length, 0);
  await call('DELETE', '/api/ideas/idea0010', null, U.jar);
  d = (await call('GET', '/api/data', null, U.jar)).j; assert.equal(d.ideas.length, 0); assert.equal(d.maps.length, 0);
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) c FROM mind_map_nodes n LEFT JOIN mind_maps m ON m.id=n.map_id WHERE m.id IS NULL').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM connections c LEFT JOIN mind_maps m ON m.id=c.map_id WHERE m.id IS NULL').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM mind_maps m LEFT JOIN ideas i ON i.id=m.idea_id WHERE i.id IS NULL').get().c, 0);
  db.close();
});
test('الأداء: خريطة 1000 عقدة تُحفظ وتُقرأ بسرعة', async () => {
  const U = await mkUser('perf'); await call('PUT', '/api/ideas/idea0020', idea('idea0020'), U.jar);
  const nodes = [node('p0000000', null)]; for (let i = 1; i < 1000; i++) nodes.push(node('p' + String(i).padStart(7, '0'), 'p' + String(Math.floor((i - 1) / 4)).padStart(7, '0'), { positionX: -i, positionY: i }));
  let t = Date.now(); assert.equal((await call('PUT', '/api/maps/idea0020', map('map00020', nodes), U.jar)).s, 200); const w = Date.now() - t;
  t = Date.now(); const d = (await call('GET', '/api/data', null, U.jar)).j; const r = Date.now() - t;
  assert.equal(d.maps[0].nodes.length, 1000); assert.ok(w < 1500 && r < 1500, `كتابة ${w}ms قراءة ${r}ms`);
  assert.equal((await call('PUT', '/api/maps/idea0020', map('map00020', [...nodes, ...nodes.map(n => ({ ...n, id: 'x' + n.id }))]), U.jar)).s, 400);   // أكثر من 2000
});
test('ملفات الواجهة: لا يُقدَّم .env ولا كود الخادم، والترويسات الأمنية موجودة', async () => {
  for (const p of ['/.env', '/server/index.js', '/package.json', '/data/fikra.db']) assert.equal((await fetch(BASE + p)).status, 404, p);
  const r = await fetch(BASE + '/'); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const js = await (await fetch(BASE + '/app.js')).text(); assert.ok(!/GEMINI_API_KEY|API_KEY|AIza|OPENAI/i.test(js));
});
