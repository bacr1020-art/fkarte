'use strict';
// التحقق من كل البيانات القادمة من الواجهة قبل حفظها. لا نثق بأي معرّف مستخدم قادم من الواجهة.
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = (m = 'بيانات غير صالحة.') => new HttpError(400, 'invalid', m);
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const STATUS = ['new', 'important', 'progress', 'paused', 'done'], PRI = ['high', 'medium', 'low'];
const TYPES = ['idea', 'feature', 'problem', 'solution', 'audience', 'competitor', 'task', 'goal', 'note', 'question'];
const COLORS = ['def', 'blue', 'purple', 'green', 'orange', 'red', 'gray'];
const FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const str = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const num = v => typeof v === 'number' && Number.isFinite(v);
const arr = (v, max) => Array.isArray(v) && v.length <= max;

function validateIdea(b, id) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad();
  if (!ID.test(id) || b.id !== id) throw bad('معرّف الفكرة غير صالح.');
  if (!str(b.title, 200, 1)) throw bad('عنوان الفكرة مطلوب (حتى 200 حرف).');
  if (b.body !== undefined && !str(b.body, 20000)) throw bad('الوصف طويل جدًا.');
  if (b.category !== undefined && !str(b.category, 60)) throw bad('التصنيف غير صالح.');
  if (b.status !== undefined && !STATUS.includes(b.status)) throw bad('حالة الفكرة غير صالحة.');
  if (b.priority !== undefined && !PRI.includes(b.priority)) throw bad('أولوية الفكرة غير صالحة.');
  if (b.progress !== undefined && !(num(b.progress) && b.progress >= 0 && b.progress <= 100)) throw bad('نسبة التقدم غير صالحة.');
  if (!num(b.createdAt) || !num(b.updatedAt)) throw bad();
  if (b.tags !== undefined && !(arr(b.tags, 30) && b.tags.every(t => str(t, 40)))) throw bad('الوسوم غير صالحة.');
  if (b.links !== undefined && !(arr(b.links, 50) && b.links.every(u => str(u, 2000) && /^https?:\/\//i.test(u)))) throw bad('الروابط غير صالحة.');
  if (b.notes !== undefined && !str(b.notes, 300000)) throw bad('الملاحظات طويلة جدًا.');
  for (const k of ['problem', 'solution', 'audience', 'model', 'remarks']) if (b[k] !== undefined && !str(b[k], 20000)) throw bad();
  if (b.tasks !== undefined && !(arr(b.tasks, 500) && b.tasks.every(t => t && ID.test(String(t.id)) && str(t.text, 300)))) throw bad('المهام غير صالحة.');
  if (b.log !== undefined && !arr(b.log, 3000)) throw bad();
  if (b.files !== undefined) {
    if (!arr(b.files, 20)) throw bad('عدد المرفقات كبير.');
    let total = 0;
    for (const f of b.files) {
      if (!f || !str(f.name, 120, 1) || !FILE_TYPES.includes(f.type) || !str(f.data, 3_000_000)) throw bad('مرفق غير صالح أو نوعه غير مدعوم.');
      if (!f.data.startsWith('data:' + f.type + ';base64,')) throw bad('مرفق غير صالح.');
      total += f.data.length;
    }
    if (total > 12_000_000) throw bad('حجم المرفقات كبير جدًا.');
  }
  return b;
}

function validateMap(b) {
  if (!b || typeof b !== 'object') throw bad();
  if (!ID.test(String(b.id || ''))) throw bad('معرّف الخريطة غير صالح.');
  if (!str(b.title, 200, 1)) throw bad('عنوان الخريطة غير صالح.');
  if (b.description !== undefined && !str(b.description, 5000)) throw bad();
  if (!arr(b.nodes, 2000) || b.nodes.length < 1) throw bad('عدد العقد غير صالح (1 إلى 2000).');
  const conns = b.conns || [];
  if (!arr(conns, 3000)) throw bad('عدد الارتباطات كبير.');
  const ids = new Set();
  for (const n of b.nodes) {
    if (!n || !ID.test(String(n.id)) || ids.has(n.id)) throw bad('معرّفات العقد غير صالحة.');
    ids.add(n.id);
    if (!str(n.title, 200, 1) || !str(n.description ?? '', 5000) || !str(n.notes ?? '', 5000)) throw bad('بيانات عقدة غير صالحة.');
    if (!TYPES.includes(n.type) || !COLORS.includes(n.color || 'def') || !str(n.icon ?? '', 8)) throw bad('نوع أو لون عقدة غير صالح.');
    if (!num(n.positionX) || !num(n.positionY) || Math.abs(n.positionX) > 1e7 || Math.abs(n.positionY) > 1e7) throw bad('موضع عقدة غير صالح.');
    if (n.order !== undefined && !num(n.order)) throw bad();
  }
  let roots = 0; const parent = new Map();
  for (const n of b.nodes) {
    if (n.parentId == null) { roots++; continue; }
    if (!ids.has(n.parentId) || n.parentId === n.id) throw bad('عقدة تشير إلى أب غير موجود.');
    parent.set(n.id, n.parentId);
  }
  if (roots !== 1) throw bad('يجب أن تحتوي الخريطة على عقدة رئيسية واحدة.');
  for (const n of b.nodes) { let c = n.id, steps = 0; while (parent.has(c)) { c = parent.get(c); if (++steps > b.nodes.length) throw bad('حلقة في شجرة العقد.'); } }
  const cids = new Set();
  for (const c of conns) {
    if (!c || !ID.test(String(c.id)) || cids.has(c.id) || !ids.has(c.sourceNodeId) || !ids.has(c.targetNodeId) || !str(c.label ?? '', 100)) throw bad('ارتباط غير صالح.');
    cids.add(c.id);
  }
  return b;
}
module.exports = { HttpError, validateIdea, validateMap, ID, bad };
