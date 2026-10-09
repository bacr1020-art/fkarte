'use strict';
// عميل Google Gemini (REST الرسمي: models/{model}:generateContent مع Structured Output).
// المفتاح يُرسل في ترويسة x-goog-api-key من الخادم فقط، ولا يظهر في أي استجابة أو سجل.
const config = require('./config');
const { HttpError } = require('./validate');

const redact = s => { let t = String(s ?? ''); const k = config.gemini.apiKey; if (k) t = t.split(k).join('[مخفي]'); return t; };
const GENERIC = 'تعذر إنشاء الخريطة الذهنية. حاول مرة أخرى.';
const fail = (status, code, message) => new HttpError(status, code, message);
const BLOCK = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'];
let inflight = 0;

async function generateJson({ system, prompt, schema, maxTokens = 4096 }) {
  const g = config.gemini;
  if (!g.enabled) throw fail(503, 'ai_not_configured', 'ميزة الذكاء الاصطناعي غير مفعّلة بعد. أضف مفتاح Gemini في إعدادات الخادم.');
  if (inflight >= config.ai.maxConcurrent) throw fail(429, 'ai_busy', 'الخدمة مشغولة الآن. حاول بعد لحظات.');
  inflight++;
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
  let status, text;
  try {
    const r = await fetch(`${g.baseUrl}/models/${encodeURIComponent(g.model)}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': g.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.8, maxOutputTokens: maxTokens },
      }),
    });
    status = r.status; text = await r.text();
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail(504, 'ai_timeout', 'استغرق الذكاء الاصطناعي وقتًا طويلًا. حاول مرة أخرى.');
    console.error('[ai] network error'); throw fail(502, 'ai_network', 'تعذر الاتصال بخدمة الذكاء الاصطناعي. حاول مرة أخرى.');
  } finally { clearTimeout(timer); inflight--; }

  if (status !== 200) {
    let detail = ''; try { const j = JSON.parse(text); detail = `${j.error?.status || ''} ${j.error?.message || ''}`; } catch (e) { /* غير JSON */ }
    console.error('[ai] http', status, redact(detail).slice(0, 200));          // لا نسجّل المفتاح ولا محتوى الفكرة
    if (status === 429) throw fail(429, 'ai_rate_limited', 'تم الوصول إلى حد الاستخدام مؤقتًا. حاول لاحقًا.');
    if (status >= 500) throw fail(502, 'ai_unavailable', 'خدمة الذكاء الاصطناعي غير متاحة الآن. حاول لاحقًا.');
    throw fail(502, 'ai_config', 'تعذر الوصول إلى الذكاء الاصطناعي. تحقق من مفتاح Gemini واسم النموذج في إعدادات الخادم.');
  }
  let body; try { body = JSON.parse(text); } catch (e) { throw fail(502, 'ai_invalid_response', GENERIC); }
  if (body.promptFeedback?.blockReason) throw fail(422, 'ai_blocked', 'تعذر معالجة هذه الفكرة. جرّب صياغة مختلفة.');
  const cand = body.candidates?.[0];
  if (!cand) throw fail(502, 'ai_invalid_response', GENERIC);
  if (BLOCK.includes(cand.finishReason)) throw fail(422, 'ai_blocked', 'تعذر معالجة هذه الفكرة. جرّب صياغة مختلفة.');
  if (cand.finishReason === 'MAX_TOKENS') throw fail(502, 'ai_invalid_response', GENERIC);
  const out = (cand.content?.parts || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
  if (!out) throw fail(502, 'ai_invalid_response', GENERIC);
  try { return JSON.parse(out.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (e) { throw fail(502, 'ai_invalid_response', GENERIC); }
}
module.exports = { generateJson, redact };
