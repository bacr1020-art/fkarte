'use strict';
const crypto = require('crypto');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
const DUMMY = crypto.randomBytes(16).toString('hex');
module.exports = {
  sha256: s => crypto.createHash('sha256').update(s).digest('hex'),
  newToken: () => crypto.randomBytes(32).toString('base64url'),
  newId: () => crypto.randomBytes(9).toString('hex'),
  async hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: (await scrypt(pw, salt)).toString('hex') }; },
  async verifyPassword(pw, salt, hash) {
    const h = (await scrypt(pw, salt || DUMMY)).toString('hex');   // نفس الكلفة حتى لو الحساب غير موجود
    if (!salt || !hash) return false;
    const a = Buffer.from(h), b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
  cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; },
  limiter(max, windowMs) {
    const m = new Map();
    return key => { const n = Date.now(), r = m.get(key); if (!r || r.reset < n) { m.set(key, { c: 1, reset: n + windowMs }); return true; } r.c++; if (m.size > 5000) m.clear(); return r.c <= max; };
  },
};
