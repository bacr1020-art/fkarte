'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const config = require('./config'), { db, tx } = require('./db'), sec = require('./security');
const { HttpError, validateIdea, validateMap, ID } = require('./validate');

const PUBLIC = path.join(config.root, 'public');
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const COOKIE = 'fikra_sid';
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; object-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};
const authLimit = sec.limiter(30, 10 * 60 * 1000);
const KV_KEYS = ['cats', 'draft'];

const pub = u => ({ id: u.id, name: u.name, email: u.email || '', guest: !!u.is_guest });
const send = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...HEADERS, ...extra });
  res.end(JSON.stringify(obj));
};
const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > config.maxBody) { reject(new HttpError(413, 'too_large', 'حجم البيانات كبير جدًا.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve(null); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'bad_json', 'بيانات غير صالحة.')); } });
    req.on('error', reject);
  });
}
function userFrom(req) {
  const t = sec.cookies(req)[COOKIE]; if (!t) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(sec.sha256(t), Date.now()) || null;
}
function startSession(res, userId, status, body) {
  const token = sec.newToken(), ttl = config.sessionDays * 86400;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sec.sha256(token), userId, Date.now() + ttl * 1000, Date.now());
  send(res, status, body, { 'Set-Cookie': cookie(token, ttl) });
}
const need = u => { if (!u) throw new HttpError(401, 'unauthorized', 'سجّل الدخول للمتابعة.'); return u; };
const notFound = () => new HttpError(404, 'not_found', 'العنصر غير موجود.');
const b01 = v => v ? 1 : 0;

function mapOut(m, nodes, conns) {
  return {
    id: m.id, userId: m.user_id, ideaId: m.idea_id, title: m.title, description: m.description, manual: !!m.manual, createdAt: m.created_at, updatedAt: m.updated_at,
    nodes: (nodes || []).map(n => ({ id: n.id, mindMapId: n.map_id, parentId: n.parent_id, title: n.title, description: n.description, notes: n.notes, type: n.type,
      positionX: n.position_x, positionY: n.position_y, color: n.color, icon: n.icon, isCollapsed: !!n.is_collapsed, isCompleted: !!n.is_completed, order: n.ord, createdAt: n.created_at, updatedAt: n.updated_at })),
    conns: (conns || []).map(c => ({ id: c.id, mindMapId: c.map_id, sourceNodeId: c.source_node_id, targetNodeId: c.target_node_id, label: c.label, createdAt: c.created_at })),
  };
}

const routes = [];
const route = (method, re, fn) => routes.push([method, re, fn]);

route('GET', /^\/api\/health$/, ({ res }) => send(res, 200, { ok: true }));
route('GET', /^\/api\/me$/, ({ res, user }) => send(res, 200, { user: user ? pub(user) : null }));

route('POST', /^\/api\/auth\/register$/, async ({ req, res, body }) => {
  if (!authLimit('r:' + req.socket.remoteAddress)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة. حاول لاحقًا.');
  const name = String(body?.name || '').trim(), email = String(body?.email || '').trim().toLowerCase(), pw = String(body?.password || '');
  if (!name || name.length > 60) throw new HttpError(400, 'invalid', 'أدخل اسمًا صالحًا.');
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new HttpError(400, 'invalid', 'أدخل بريدًا إلكترونيًا صحيحًا.');
  if (pw.length < 8 || pw.length > 128) throw new HttpError(400, 'invalid', 'كلمة المرور يجب أن تكون بين 8 و128 حرفًا.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'email_taken', 'هذا البريد مسجّل مسبقًا. جرّب تسجيل الدخول.');
  const { salt, hash } = await sec.hashPassword(pw), id = sec.newId();
  db.prepare('INSERT INTO users(id,name,email,pw_salt,pw_hash,is_guest,created_at) VALUES(?,?,?,?,?,0,?)').run(id, name, email, salt, hash, Date.now());
  startSession(res, id, 201, { user: { id, name, email, guest: false } });
});
route('POST', /^\/api\/auth\/login$/, async ({ req, res, body }) => {
  const email = String(body?.email || '').trim().toLowerCase(), pw = String(body?.password || '');
  if (!authLimit('l:' + req.socket.remoteAddress + ':' + email)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة. حاول لاحقًا.');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!(await sec.verifyPassword(pw, u?.pw_salt, u?.pw_hash)) || !u) throw new HttpError(401, 'bad_credentials', 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
  startSession(res, u.id, 200, { user: pub(u) });
});
route('POST', /^\/api\/auth\/guest$/, ({ req, res }) => {
  if (!authLimit('g:' + req.socket.remoteAddress)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة. حاول لاحقًا.');
  const id = sec.newId();
  db.prepare("INSERT INTO users(id,name,email,is_guest,created_at) VALUES(?, 'زائر', NULL, 1, ?)").run(id, Date.now());
  startSession(res, id, 201, { user: { id, name: 'زائر', email: '', guest: true } });
});
route('POST', /^\/api\/auth\/logout$/, ({ req, res }) => {
  const t = sec.cookies(req)[COOKIE]; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sec.sha256(t));
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
});

route('GET', /^\/api\/data$/, ({ res, user }) => {
  need(user);
  const ideas = db.prepare('SELECT data FROM ideas WHERE user_id=? ORDER BY updated_at DESC').all(user.id).map(r => JSON.parse(r.data));
  const maps = db.prepare('SELECT * FROM mind_maps WHERE user_id=?').all(user.id);
  const nodes = db.prepare('SELECT n.* FROM mind_map_nodes n JOIN mind_maps m ON m.id=n.map_id WHERE m.user_id=? ORDER BY n.rowid').all(user.id);
  const conns = db.prepare('SELECT c.* FROM connections c JOIN mind_maps m ON m.id=c.map_id WHERE m.user_id=? ORDER BY c.rowid').all(user.id);
  const by = (rows, k) => rows.reduce((o, r) => ((o[r[k]] ||= []).push(r), o), {});
  const nb = by(nodes, 'map_id'), cb = by(conns, 'map_id');
  const kv = {}; db.prepare('SELECT k,v FROM user_kv WHERE user_id=?').all(user.id).forEach(r => { try { kv[r.k] = JSON.parse(r.v); } catch (e) { /* تجاهل */ } });
  send(res, 200, { ideas, maps: maps.map(m => mapOut(m, nb[m.id], cb[m.id])), kv });
});

route('PUT', /^\/api\/ideas\/([^/]+)$/, ({ res, user, body, m }) => {
  need(user); const id = m[1]; validateIdea(body, id);
  const row = db.prepare('SELECT user_id FROM ideas WHERE id=?').get(id);
  if (row && row.user_id !== user.id) throw notFound();        // لا نكشف وجود معرّف مستخدم آخر
  db.prepare(`INSERT INTO ideas(id,user_id,title,created_at,updated_at,archived,favorite,data) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at,archived=excluded.archived,favorite=excluded.favorite,data=excluded.data WHERE ideas.user_id=excluded.user_id`)
    .run(id, user.id, body.title, body.createdAt, body.updatedAt, b01(body.archived), b01(body.favorite), JSON.stringify(body));
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/ideas\/([^/]+)$/, ({ res, user, m }) => {
  need(user); db.prepare('DELETE FROM ideas WHERE id=? AND user_id=?').run(m[1], user.id);   // يحذف الخريطة والعقد تلقائيًا (CASCADE)
  send(res, 200, { ok: true });
});

route('PUT', /^\/api\/maps\/([^/]+)$/, ({ res, user, body, m }) => {
  need(user); const ideaId = m[1];
  if (!ID.test(ideaId)) throw new HttpError(400, 'invalid', 'معرّف غير صالح.');
  if (!db.prepare('SELECT 1 FROM ideas WHERE id=? AND user_id=?').get(ideaId, user.id)) throw notFound();
  validateMap(body);
  const now = Date.now();
  tx(() => {
    let map = db.prepare('SELECT * FROM mind_maps WHERE idea_id=?').get(ideaId);
    if (!map) {
      if (db.prepare('SELECT 1 FROM mind_maps WHERE id=?').get(body.id)) throw new HttpError(409, 'conflict', 'تعارض في معرّف الخريطة.');
      db.prepare('INSERT INTO mind_maps(id,user_id,idea_id,title,description,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(body.id, user.id, ideaId, body.title, body.description || '', b01(body.manual), body.createdAt || now, now);
      map = { id: body.id };
    } else {
      db.prepare('UPDATE mind_maps SET title=?,description=?,manual=?,updated_at=? WHERE id=?').run(body.title, body.description || '', b01(body.manual), now, map.id);
      db.prepare('DELETE FROM mind_map_nodes WHERE map_id=?').run(map.id);
      db.prepare('DELETE FROM connections WHERE map_id=?').run(map.id);
    }
    const ins = db.prepare('INSERT INTO mind_map_nodes(map_id,id,parent_id,title,description,notes,type,position_x,position_y,color,icon,is_collapsed,is_completed,ord,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const n of body.nodes) ins.run(map.id, n.id, n.parentId ?? null, n.title, n.description || '', n.notes || '', n.type, n.positionX, n.positionY, n.color || 'def', n.icon || '', b01(n.isCollapsed), b01(n.isCompleted), n.order ?? 0, n.createdAt || now, n.updatedAt || now);
    const ci = db.prepare('INSERT INTO connections(map_id,id,source_node_id,target_node_id,label,created_at) VALUES(?,?,?,?,?,?)');
    for (const c of body.conns || []) ci.run(map.id, c.id, c.sourceNodeId, c.targetNodeId, c.label || '', c.createdAt || now);
  });
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/maps\/([^/]+)$/, ({ res, user, m }) => {
  need(user); db.prepare('DELETE FROM mind_maps WHERE idea_id=? AND user_id=?').run(m[1], user.id);
  send(res, 200, { ok: true });
});

route('PUT', /^\/api\/kv\/([a-z]+)$/, ({ res, user, body, m }) => {
  need(user); if (!KV_KEYS.includes(m[1])) throw notFound();
  const v = JSON.stringify(body ?? null); if (v.length > 200000) throw new HttpError(413, 'too_large', 'البيانات كبيرة جدًا.');
  db.prepare('INSERT INTO user_kv(user_id,k,v) VALUES(?,?,?) ON CONFLICT(user_id,k) DO UPDATE SET v=excluded.v').run(user.id, m[1], v);
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/kv\/([a-z]+)$/, ({ res, user, m }) => {
  need(user); db.prepare('DELETE FROM user_kv WHERE user_id=? AND k=?').run(user.id, m[1]); send(res, 200, { ok: true });
});

require('./ai-routes')({ route, send, need, mapOut, db, tx, sec, notFound });

function serveStatic(req, res, pathname) {
  const f = FILES[pathname]; if (!f || req.method !== 'GET') return false;
  const data = fs.readFileSync(path.join(PUBLIC, f));
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache', ...HEADERS }); res.end(data); return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      if (serveStatic(req, res, pathname)) return;
      return send(res, 404, { error: 'not_found', message: 'الصفحة غير موجودة.' });
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) {                                  // حماية CSRF: ترويسة مخصصة + تطابق الأصل
      const origin = req.headers.origin;
      if (req.headers['x-fikra'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) throw new HttpError(403, 'forbidden', 'طلب غير مسموح.');
    }
    for (const [method, re, fn] of routes) {
      const m = pathname.match(re);
      if (m && method === req.method) {
        const body = mutating ? await readBody(req) : null;
        return await fn({ req, res, user: userFrom(req), body, m });
      }
    }
    throw new HttpError(404, 'not_found', 'المسار غير موجود.');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
    console.error('[خطأ داخلي]', e && e.message);   // لا نعرض التفاصيل للمستخدم ولا نسجّل بيانات حساسة
    send(res, 500, { error: 'server_error', message: 'حدث خطأ غير متوقع.' });
  }
});
server.requestTimeout = 30000;
if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`فِكرة تعمل على http://${config.host}:${config.port}  (${config.env})`);
    console.log(`الذكاء الاصطناعي: ${config.gemini.enabled ? 'مفعّل' : 'غير مفعّل (لا يوجد مفتاح)'} | النموذج: ${config.gemini.model}`);   // لا نطبع المفتاح أبدًا
  });
  // Render يرسل SIGTERM عند كل نشر: نغلق بهدوء حتى تُحفظ قاعدة البيانات سليمة.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
module.exports = server;
