'use strict';
// مسارات الذكاء الاصطناعي: كلها تتطلب مصادقة وتتحقق من ملكية الفكرة والخريطة والعقدة على الخادم.
const config = require('./config'), gemini = require('./gemini'), ai = require('./ai');
const { HttpError, ID } = require('./validate');

module.exports = function register({ route, send, need, mapOut, db, tx, sec, notFound }) {
  const minute = sec.limiter(config.ai.perMinute, 60 * 1000);
  const LIMIT = () => new HttpError(429, 'ai_rate_limited', 'تم الوصول إلى حد الاستخدام مؤقتًا. حاول لاحقًا.');
  function quota(userId) {
    if (!minute('ai:' + userId)) throw LIMIT();
    const day = new Date().toISOString().slice(0, 10), row = db.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').get(userId, day);
    if (row && row.count >= config.ai.dailyLimit) throw LIMIT();
    db.prepare('INSERT INTO ai_usage(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').run(userId, day);
  }
  const needAi = () => { if (!config.gemini.enabled) throw new HttpError(503, 'ai_not_configured', 'ميزة الذكاء الاصطناعي غير مفعّلة بعد. أضف مفتاح Gemini في إعدادات الخادم.'); };
  const idOf = v => { const s = String(v || ''); if (!ID.test(s)) throw new HttpError(400, 'invalid', 'معرّف غير صالح.'); return s; };
  const insNode = () => db.prepare('INSERT INTO mind_map_nodes(map_id,id,parent_id,title,description,notes,type,position_x,position_y,color,icon,is_collapsed,is_completed,ord,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const fullMap = id => {
    const m = db.prepare('SELECT * FROM mind_maps WHERE id=?').get(id);
    return mapOut(m, db.prepare('SELECT * FROM mind_map_nodes WHERE map_id=? ORDER BY rowid').all(id), db.prepare('SELECT * FROM connections WHERE map_id=? ORDER BY rowid').all(id));
  };

  route('GET', /^\/api\/ai\/status$/, ({ res, user }) => { need(user); send(res, 200, { enabled: config.gemini.enabled }); });

  // فكرة -> خريطة ذهنية
  route('POST', /^\/api\/ai\/map$/, async ({ res, user, body }) => {
    need(user); const ideaId = idOf(body?.ideaId);
    const row = db.prepare('SELECT data FROM ideas WHERE id=? AND user_id=?').get(ideaId, user.id); if (!row) throw notFound();
    const existing = db.prepare('SELECT * FROM mind_maps WHERE idea_id=? AND user_id=?').get(ideaId, user.id);
    if (existing && body.replace !== true) throw new HttpError(409, 'map_exists', 'توجد خريطة ذهنية حالية. هل تريد استبدالها بالخريطة الجديدة؟');
    const idea = JSON.parse(row.data), ctx = ai.ideaContext(idea);
    needAi(); quota(user.id);
    const raw = await gemini.generateJson({ system: ai.SYSTEM_MAP, prompt: ai.buildMapPrompt(ctx), schema: ai.MAP_SCHEMA, maxTokens: 8192 });
    const flat = ai.normalizeMap(raw);                       // لا نكتب شيئًا في قاعدة البيانات قبل نجاح التحقق
    const now = Date.now(), ids = flat.map(() => sec.newId());
    const mapId = tx(() => {
      let id;
      const cur = db.prepare('SELECT id FROM mind_maps WHERE idea_id=? AND user_id=?').get(ideaId, user.id);
      if (cur) {
        id = cur.id;
        db.prepare('DELETE FROM mind_map_nodes WHERE map_id=?').run(id); db.prepare('DELETE FROM connections WHERE map_id=?').run(id);
        db.prepare('UPDATE mind_maps SET title=?,manual=0,updated_at=? WHERE id=?').run(String(idea.title).slice(0, 200), now, id);
      } else {
        id = sec.newId();
        db.prepare('INSERT INTO mind_maps(id,user_id,idea_id,title,description,manual,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)').run(id, user.id, ideaId, String(idea.title).slice(0, 200), '', now, now);
      }
      const ins = insNode(), order = new Map();
      flat.forEach((n, i) => {
        const ord = order.get(n.parent) ?? 0; order.set(n.parent, ord + 1);
        ins.run(id, ids[i], n.parent === null ? null : ids[n.parent], n.title, n.description, '', n.type, 0, 0, 'def', n.parent === null || n.type !== 'idea' ? ai.ICONS[n.type] : '', 0, 0, ord, now, now);
      });
      return id;
    });
    send(res, 200, { map: fullMap(mapId), added: flat.length });
  });

  // توسيع عقدة واحدة: إضافة أبناء جدد لها فقط
  route('POST', /^\/api\/ai\/expand$/, async ({ res, user, body }) => {
    need(user); const ideaId = idOf(body?.ideaId), nodeId = idOf(body?.nodeId);
    const row = db.prepare('SELECT data FROM ideas WHERE id=? AND user_id=?').get(ideaId, user.id); if (!row) throw notFound();
    const map = db.prepare('SELECT * FROM mind_maps WHERE idea_id=? AND user_id=?').get(ideaId, user.id); if (!map) throw notFound();
    const nodes = db.prepare('SELECT * FROM mind_map_nodes WHERE map_id=? ORDER BY rowid').all(map.id);
    const node = nodes.find(n => n.id === nodeId); if (!node) throw notFound();
    if (nodes.length >= 2000 - config.ai.maxExpandNodes) throw new HttpError(400, 'too_many_nodes', 'الخريطة وصلت إلى الحد الأقصى من العقد.');
    const ctx = ai.ideaContext(JSON.parse(row.data)), by = new Map(nodes.map(n => [n.id, n]));
    const path = []; for (let c = node, k = 0; c && k < 50; c = by.get(c.parent_id), k++) path.unshift(c.title);
    const existing = nodes.filter(n => n.parent_id === node.id).map(n => n.title);
    const siblings = nodes.filter(n => n.parent_id === node.parent_id && n.id !== node.id).map(n => n.title);
    const root = nodes.find(n => !n.parent_id), branches = nodes.filter(n => root && n.parent_id === root.id).map(n => n.title);
    needAi(); quota(user.id);
    const raw = await gemini.generateJson({ system: ai.SYSTEM_EXPAND, prompt: ai.buildExpandPrompt({ ctx, path, node: { title: node.title, type: node.type, description: node.description }, existing, siblings, branches }), schema: ai.EXPAND_SCHEMA, maxTokens: 4096 });
    const flat = ai.normalizeExpand(raw, existing);
    if (!flat.length) throw new HttpError(422, 'no_new_children', 'لم يقترح الذكاء الاصطناعي فروعًا جديدة. جرّب مرة أخرى.');
    const now = Date.now(), ids = flat.map(() => sec.newId());
    tx(() => {
      const maxOrd = db.prepare('SELECT COALESCE(MAX(ord),-1) m FROM mind_map_nodes WHERE map_id=? AND parent_id=?').get(map.id, node.id).m;
      const ins = insNode(), order = new Map();
      flat.forEach((n, i) => {
        const ord = n.parent === null ? maxOrd + 1 + (order.get('top') ?? 0) : (order.get(n.parent) ?? 0);
        order.set(n.parent === null ? 'top' : n.parent, (order.get(n.parent === null ? 'top' : n.parent) ?? 0) + 1);
        ins.run(map.id, ids[i], n.parent === null ? node.id : ids[n.parent], n.title, n.description, '', n.type, node.position_x - 280, node.position_y + i * 50, 'def', ai.ICONS[n.type], 0, 0, ord, now, now);
      });
      db.prepare('UPDATE mind_map_nodes SET is_collapsed=0,updated_at=? WHERE map_id=? AND id=?').run(now, map.id, node.id);
      db.prepare('UPDATE mind_maps SET updated_at=? WHERE id=?').run(now, map.id);
    });
    send(res, 200, { map: fullMap(map.id), added: flat.length });
  });
};
