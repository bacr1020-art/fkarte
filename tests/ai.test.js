'use strict';
// اختبارات تكامل Gemini بدون إنترنت: خادم Gemini تجريبي + خادم فِكرة الحقيقي + قاعدة بيانات مؤقتة.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
const { srv: mock, KEY } = require('./mock-gemini');

const rnd = () => 3700 + Math.floor(Math.random() * 1500);
const MOCK_PORT = rnd(), MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const procs = [], logs = [], files = [];
async function boot(env = {}) {
  const port = rnd(), db = path.join(os.tmpdir(), `fikra-ai-${process.pid}-${port}.db`); files.push(db);
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server/index.js')],
    { env: { ...process.env, PORT: String(port), DATABASE_PATH: db, GEMINI_BASE_URL: `${MOCK}/v1beta`, GEMINI_API_KEY: KEY, GEMINI_MODEL: 'test-model', AI_PER_MINUTE: '50', AI_DAILY_LIMIT: '500', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => logs.push(String(d))); p.stderr.on('data', d => logs.push(String(d))); procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return base; } catch (e) { /* انتظر */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('الخادم لم يبدأ');
}
let BASE;
before(async () => { await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r)); BASE = await boot(); });
after(() => { mock.close(); procs.forEach(p => p.kill()); files.forEach(f => ['', '-wal', '-shm'].forEach(s => fs.rmSync(f + s, { force: true }))); });

const ctl = (path, body) => fetch(MOCK + path, { method: 'POST', body: JSON.stringify(body || {}) });
const calls = async () => (await fetch(MOCK + '/__calls')).json();
async function call(base, method, url, body, jar) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Fikra': '1', ...(jar?.c ? { Cookie: jar.c } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc && jar) jar.c = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) { /* فارغ */ } return { s: r.status, j };
}
const api = (m, u, b, jar) => call(BASE, m, u, b, jar);
async function user(name, base = BASE) { const jar = {}; const r = await call(base, 'POST', '/api/auth/register', { name, email: `${name}${Math.random().toString(36).slice(2, 7)}@t.com`, password: '12345678' }, jar); assert.equal(r.s, 201); return jar; }
const now = Date.now();
let seq = 0;
async function mkIdea(jar, extra = {}, base = BASE) {
  const id = 'idea' + String(++seq).padStart(5, '0') + Math.random().toString(36).slice(2, 6);
  const r = await call(base, 'PUT', '/api/ideas/' + id, { id, title: 'تطبيق تعليم البرمجة للأطفال', body: 'أريد تطبيق يعلّم الأطفال البرمجة بشكل ممتع', status: 'new', priority: 'medium', progress: 0, createdAt: now, updatedAt: now, ...extra }, jar);
  assert.equal(r.s, 200); return id;
}
const dataOf = async (jar, base = BASE) => (await call(base, 'GET', '/api/data', null, jar)).j;
const TYPES = ['idea', 'feature', 'problem', 'solution', 'audience', 'competitor', 'task', 'goal', 'note', 'question'];

test('المخطط (schema) صالح ويحتوي الأنواع العشرة وحقول root/title/description/type/children', () => {
  const ai = require('../server/ai');
  const s = ai.MAP_SCHEMA, root = s.properties.root;
  assert.deepEqual(s.required, ['root']);
  assert.deepEqual(root.required, ['title', 'description', 'type', 'children']);
  assert.deepEqual(root.properties.type.enum, TYPES);
  let d = 0, n = root; while (n.properties.children) { n = n.properties.children.items; d++; assert.ok(n.properties.type.enum.length === 10); }
  assert.equal(d, 3);
  assert.ok(JSON.stringify(s).length < 6000);                         // مخطط صغير، لا يُرفض لتعقيده
  assert.deepEqual(ai.EXPAND_SCHEMA.required, ['children']);
  JSON.parse(JSON.stringify(s));
});
test('التحقق من ناتج Gemini: يقبل الصالح ويرفض المخالف ويحد العدد ويحذف التكرار', () => {
  const ai = require('../server/ai'), L = (t, type = 'feature', children) => ({ title: t, description: 'د', type, ...(children ? { children } : {}) });
  const ok = ai.normalizeMap({ root: L('ج', 'idea', [L('أ', 'audience', [L('أأ')]), L('الجمهور'), L('الجُمهور')]) });
  assert.equal(ok[0].parent, null); assert.equal(ok.filter(n => n.parent === 0).length, 2);          // 'الجمهور' و'الجُمهور' مكرران بعد التطبيع
  const big = { root: L('ج', 'idea', Array.from({ length: 8 }, (_, i) => L('ف' + i, 'feature', Array.from({ length: 6 }, (_, k) => L(`ف${i}-${k}`, 'feature', Array.from({ length: 4 }, (_, m) => L(`ف${i}-${k}-${m}`)))))) ) };
  assert.ok(ai.normalizeMap(big).length <= 80);
  for (const bad of [null, {}, { root: L('x', 'evil', []) }, { root: { description: 'd', type: 'idea' } }, { root: { title: 'x', description: 'd', type: 'idea', children: 'no' } }, { root: L('x', 'idea', []) }])
    assert.throws(() => ai.normalizeMap(bad), /تعذر إنشاء/);
  const ex = ai.normalizeExpand({ children: [L('إنستغرام'), L('أنستغرام'), L('جديد')] }, ['إنستغرام']);
  assert.deepEqual(ex.map(n => n.title), ['جديد']);                       // التكرار (مع اختلاف الهمزة) سقط
  assert.throws(() => ai.ideaContext({ title: '' }), /عنوانًا/);
});

test('الأمان: مصادقة مطلوبة، والملكية تُفحص على الخادم (A لا يستطيع التوسيع/التحويل لفكرة B)', async () => {
  assert.equal((await api('POST', '/api/ai/map', { ideaId: 'idea00000x' })).s, 401);
  assert.equal((await api('POST', '/api/ai/expand', { ideaId: 'idea00000x', nodeId: 'node00001' })).s, 401);
  const A = await user('A'), B = await user('B'), idA = await mkIdea(A);
  await ctl('/__reset'); const before = (await calls()).length;
  assert.equal((await api('POST', '/api/ai/map', { ideaId: idA }, B)).s, 404);
  assert.equal((await api('POST', '/api/ai/map', { ideaId: 'x' }, A)).s, 400);
  assert.equal((await api('POST', '/api/ai/map', { ideaId: 'nonexist001' }, A)).s, 404);
  const r = await api('POST', '/api/ai/map', { ideaId: idA }, A); assert.equal(r.s, 200);
  const node = r.j.map.nodes[1];
  assert.equal((await api('POST', '/api/ai/expand', { ideaId: idA, nodeId: node.id }, B)).s, 404);
  const idB = await mkIdea(B);
  assert.equal((await api('POST', '/api/ai/expand', { ideaId: idB, nodeId: node.id }, B)).s, 404);   // فكرة B بلا خريطة
  const rb = await api('POST', '/api/ai/map', { ideaId: idB }, B); assert.equal(rb.s, 200);
  assert.equal((await api('POST', '/api/ai/expand', { ideaId: idB, nodeId: node.id }, B)).s, 404);   // عقدة تتبع خريطة A
  assert.equal((await calls()).length - before, 2);                                                // لم يُستدعَ Gemini لأي طلب مرفوض
});

test('فكرة -> خريطة: الطلب إلى Gemini صحيح، والناتج يُحفظ عقدًا وعلاقات ويعود كاملًا', async () => {
  await ctl('/__reset'); const U = await user('gen'), id = await mkIdea(U);
  const r = await api('POST', '/api/ai/map', { ideaId: id }, U); assert.equal(r.s, 200);
  const c = (await calls())[0], g = c.body.generationConfig;
  assert.equal(c.model, 'test-model');                                                        // النموذج من البيئة
  assert.equal(g.responseMimeType, 'application/json'); assert.ok(g.responseJsonSchema.properties.root);
  assert.match(c.body.systemInstruction.parts[0].text, /Fikra Strategic Idea Mapping Engine/);
  assert.match(c.body.contents[0].parts[0].text, /تطبيق تعليم البرمجة للأطفال/);
  assert.ok(!/test-key|password|email/i.test(JSON.stringify(c.body)));                       // لا مفتاح ولا بيانات حساب في الطلب
  const m = r.j.map; assert.equal(m.nodes.filter(n => !n.parentId).length, 1);
  assert.equal(m.nodes[0].title, 'تطبيق تعليم البرمجة للأطفال'); assert.equal(m.nodes[0].type, 'idea'); assert.equal(m.userId, (await api('GET', '/api/me', null, U)).j.user.id);
  const ids = new Set(m.nodes.map(n => n.id)); m.nodes.forEach(n => { assert.ok(!n.parentId || ids.has(n.parentId)); assert.ok(TYPES.includes(n.type)); assert.equal(n.mindMapId, m.id); });
  assert.equal(m.nodes.filter(n => n.title === 'الجمهور').length, 1);                       // المكرر سقط
  assert.ok(m.nodes.length >= 10 && m.nodes.length <= 80); assert.equal(m.manual, false);
  const d = await dataOf(U); assert.equal(d.maps.length, 1); assert.equal(d.maps[0].nodes.length, m.nodes.length);   // محفوظة فعلًا
  assert.ok(!JSON.stringify(r.j).includes('test-key'));
});
test('خريطة موجودة: 409 بدون تأكيد ولا يُستدعى Gemini، ومع replace تُستبدل كاملة', async () => {
  await ctl('/__reset'); const U = await user('rep'), id = await mkIdea(U);
  assert.equal((await api('POST', '/api/ai/map', { ideaId: id }, U)).s, 200);
  const old = (await dataOf(U)).maps[0], n0 = (await calls()).length;
  const r = await api('POST', '/api/ai/map', { ideaId: id }, U); assert.equal(r.s, 409); assert.equal(r.j.error, 'map_exists');
  assert.match(r.j.message, /توجد خريطة ذهنية حالية/); assert.equal((await calls()).length, n0);
  assert.equal((await api('POST', '/api/ai/map', { ideaId: id, replace: 'yes' }, U)).s, 409);   // لا بد من true صريحة
  const r2 = await api('POST', '/api/ai/map', { ideaId: id, replace: true }, U); assert.equal(r2.s, 200);
  const d = await dataOf(U); assert.equal(d.maps.length, 1); assert.equal(d.maps[0].id, old.id);
  assert.ok(!r2.j.map.nodes.some(n => old.nodes.some(o => o.id === n.id)));                   // العقد القديمة استُبدلت
});
test('فشل Gemini لا يفقد البيانات: خريطة قائمة تبقى كما هي مع كل أنواع الأخطاء', async () => {
  await ctl('/__reset'); const U = await user('fail'), id = await mkIdea(U);
  assert.equal((await api('POST', '/api/ai/map', { ideaId: id }, U)).s, 200);
  const snap = JSON.stringify((await dataOf(U)).maps[0]);
  const expect = { badjson: [502, /تعذر إنشاء/], badtype: [502, /تعذر إنشاء/], missingtitle: [502, /تعذر إنشاء/], noroot: [502, /تعذر إنشاء/], nokids: [502, /تعذر إنشاء/], empty: [502, /تعذر إنشاء/], nocontent: [502, /تعذر إنشاء/], maxtokens: [502, /تعذر إنشاء/],
    blocked: [422, /صياغة مختلفة/], safety: [422, /صياغة مختلفة/], http429: [429, /حد الاستخدام/], http500: [502, /غير متاحة/], http400: [502, /مفتاح Gemini/] };
  for (const [mode, [status, msg]] of Object.entries(expect)) {
    await ctl('/__mode', { mode });
    const r = await api('POST', '/api/ai/map', { ideaId: id, replace: true }, U);
    assert.equal(r.s, status, mode); assert.match(r.j.message, msg, mode);
    assert.ok(!/test-key|SECRET|stack|at \w+ \(/i.test(JSON.stringify(r.j)), 'تسريب في ' + mode);
    assert.equal(JSON.stringify((await dataOf(U)).maps[0]), snap, 'تغيّرت الخريطة بعد ' + mode);
  }
  await ctl('/__reset');
});
test('المهلة: Gemini بطيء -> 504 برسالة عربية واضحة', async () => {
  const base = await boot({ AI_TIMEOUT_MS: '400' }), U = await user('slow', base), id = await mkIdea(U, {}, base);
  await ctl('/__reset'); await ctl('/__mode', { delay: 1500 });
  const r = await call(base, 'POST', '/api/ai/map', { ideaId: id }, U); assert.equal(r.s, 504); assert.match(r.j.message, /وقتًا طويلًا/);
  await ctl('/__reset');
});
test('التحقق من الإدخال: فكرة طويلة جدًا، ومعرّفات غير صالحة، وجسم فارغ', async () => {
  await ctl('/__reset'); const U = await user('inp'), n0 = (await calls()).length;
  const long = await mkIdea(U, { body: 'ا'.repeat(7000) });
  const r = await api('POST', '/api/ai/map', { ideaId: long }, U); assert.equal(r.s, 400); assert.match(r.j.message, /طويلة جدًا/);
  assert.equal((await api('POST', '/api/ai/map', {}, U)).s, 400); assert.equal((await api('POST', '/api/ai/map', null, U)).s, 400);
  assert.equal((await api('POST', '/api/ai/expand', { ideaId: long, nodeId: '../x' }, U)).s, 400);
  assert.equal((await calls()).length, n0);
});
test('التوسيع: يضيف أبناء جددًا للعقدة المحددة فقط ويحفظها، ويتجاهل المكرر', async () => {
  await ctl('/__reset'); const U = await user('exp'), id = await mkIdea(U);
  const gen = (await api('POST', '/api/ai/map', { ideaId: id }, U)).j.map, target = gen.nodes.find(n => n.title === 'المنافسون');
  const before = new Map(gen.nodes.map(n => [n.id, JSON.stringify(n)]));
  const r = await api('POST', '/api/ai/expand', { ideaId: id, nodeId: target.id }, U); assert.equal(r.s, 200);
  const c = (await calls()).at(-1); assert.ok(c.body.generationConfig.responseJsonSchema.properties.children);
  const p = c.body.contents[0].parts[0].text; assert.match(p, /المنافسون/); assert.match(p, /Branch path/); assert.match(p, /الجمهور/);   // السياق: المسار + فروع الخريطة
  const m = r.j.map, added = m.nodes.filter(n => !before.has(n.id));
  assert.equal(added.length, r.j.added); assert.ok(added.length >= 4);
  assert.ok(added.filter(n => n.parentId === target.id).length === 4);                      // مرتبطة بالعقدة المحددة
  assert.ok(added.every(n => TYPES.includes(n.type)));
  m.nodes.filter(n => before.has(n.id)).forEach(n => { const o = JSON.parse(before.get(n.id)); assert.equal(n.title, o.title); assert.equal(n.parentId, o.parentId); });   // لم يُمَس غيرها
  assert.equal((await dataOf(U)).maps[0].nodes.length, m.nodes.length);
  const again = await api('POST', '/api/ai/expand', { ideaId: id, nodeId: target.id }, U);
  assert.equal(again.s, 422); assert.equal(again.j.error, 'no_new_children');               // نفس الأبناء مرة ثانية = لا جديد
  assert.equal((await dataOf(U)).maps[0].nodes.length, m.nodes.length);
});
test('حدود الاستخدام: دقيقة ويوم، دون استدعاء Gemini عند الرفض', async () => {
  const b1 = await boot({ AI_PER_MINUTE: '2' }), U = await user('lim', b1); await ctl('/__reset');
  const ids = [await mkIdea(U, {}, b1), await mkIdea(U, {}, b1), await mkIdea(U, {}, b1)];
  assert.equal((await call(b1, 'POST', '/api/ai/map', { ideaId: ids[0] }, U)).s, 200); assert.equal((await call(b1, 'POST', '/api/ai/map', { ideaId: ids[1] }, U)).s, 200);
  const n = (await calls()).length, r = await call(b1, 'POST', '/api/ai/map', { ideaId: ids[2] }, U);
  assert.equal(r.s, 429); assert.match(r.j.message, /حد الاستخدام/); assert.equal((await calls()).length, n);
  const b2 = await boot({ AI_DAILY_LIMIT: '1' }), V = await user('day', b2), i2 = [await mkIdea(V, {}, b2), await mkIdea(V, {}, b2)];
  assert.equal((await call(b2, 'POST', '/api/ai/map', { ideaId: i2[0] }, V)).s, 200);
  assert.equal((await call(b2, 'POST', '/api/ai/map', { ideaId: i2[1] }, V)).s, 429);
});
test('بدون مفتاح (القيمة الافتراضية PASTE_YOUR...) تعمل بقية الميزات وتظهر رسالة واضحة', async () => {
  const b = await boot({ GEMINI_API_KEY: 'PASTE_YOUR_GEMINI_API_KEY_HERE' }), U = await user('nokey', b), id = await mkIdea(U, {}, b);
  assert.equal((await call(b, 'GET', '/api/ai/status', null, U)).j.enabled, false);
  await ctl('/__reset'); const r = await call(b, 'POST', '/api/ai/map', { ideaId: id }, U);
  assert.equal(r.s, 503); assert.equal(r.j.error, 'ai_not_configured'); assert.equal((await calls()).length, 0);
  assert.equal((await call(b, 'GET', '/api/data', null, U)).s, 200);
});
test('المفتاح الخاطئ: Gemini يرد 403 -> رسالة عامة بدون تسريب المفتاح، ولا يظهر في السجلات', async () => {
  const b = await boot({ GEMINI_API_KEY: 'wrong-key-12345' }), U = await user('wk', b), id = await mkIdea(U, {}, b);
  const r = await call(b, 'POST', '/api/ai/map', { ideaId: id }, U); assert.equal(r.s, 502); assert.match(r.j.message, /مفتاح Gemini/);
  assert.ok(!JSON.stringify(r.j).includes('wrong-key'));
  await new Promise(r => setTimeout(r, 200)); const all = logs.join('');
  assert.ok(!all.includes('wrong-key-12345') && !all.includes(KEY), 'المفتاح ظهر في السجلات');
});
test('لا مفتاح في الواجهة ولا في أي ملف يُقدَّم للمتصفح، والواجهة تستدعي مسارات الخادم فقط', async () => {
  for (const p of ['/', '/app.js', '/app.css']) { const t = await (await fetch(BASE + p)).text(); assert.ok(!/GEMINI_API_KEY|AIza|generativelanguage|test-key/i.test(t), p); }
  const js = await (await fetch(BASE + '/app.js')).text(); assert.match(js, /\/api\/ai\/map/); assert.match(js, /\/api\/ai\/expand/);
});
