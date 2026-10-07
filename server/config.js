'use strict';
// تحميل متغيرات البيئة من .env (بدون مكتبات خارجية). القيم الموجودة في البيئة لها الأولوية.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (e) { /* لا يوجد .env: نستخدم القيم الافتراضية */ }
const e = process.env;
const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);
const env = e.NODE_ENV || 'development';
const key = (e.GEMINI_API_KEY || '').trim();
const OFFICIAL = 'https://generativelanguage.googleapis.com/v1beta';
module.exports = {
  root, env,
  // في الإنتاج (Render) يجب الاستماع على كل الواجهات؛ محليًا نكتفي بالجهاز نفسه.
  host: e.HOST || (env === 'production' ? '0.0.0.0' : '127.0.0.1'),
  port: int(e.PORT, 3000),
  dbPath: path.resolve(root, e.DATABASE_PATH || 'data/fikra.db'),
  sessionDays: int(e.SESSION_TTL_DAYS, 30),
  cookieSecure: (e.COOKIE_SECURE ?? (env === 'production' ? 'true' : 'false')) === 'true',
  maxBody: int(e.MAX_BODY_MB, 16) * 1024 * 1024,
  // Gemini: المفتاح يُقرأ من البيئة فقط ولا يُرسل للواجهة ولا يُسجَّل.
  gemini: {
    apiKey: key,
    enabled: !!key && !/PASTE_YOUR|YOUR_GEMINI/i.test(key),
    model: (e.GEMINI_MODEL || 'gemini-3.8-flash').trim(),
    // تجاوز العنوان (للاختبار المحلي فقط) مقفل في الإنتاج: المفتاح لا يُرسل إلا إلى خوادم Google الرسمية.
    baseUrl: (env === 'production' ? OFFICIAL : (e.GEMINI_BASE_URL || OFFICIAL)).replace(/\/$/, ''),
    timeoutMs: int(e.AI_TIMEOUT_MS, 40000),
  },
  ai: {
    perMinute: int(e.AI_PER_MINUTE, 5),
    dailyLimit: int(e.AI_DAILY_LIMIT, 100),
    maxInput: int(e.AI_MAX_INPUT_CHARS, 6000),
    maxMapNodes: int(e.AI_MAX_MAP_NODES, 80),
    maxExpandNodes: int(e.AI_MAX_EXPAND_NODES, 30),
    maxConcurrent: int(e.AI_MAX_CONCURRENT, 3),
  },
};
