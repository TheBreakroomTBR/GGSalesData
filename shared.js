const crypto = require('crypto');

const SALES = process.env.AIRTABLE_SALES_TABLE || 'Sales';
const SETTINGS = process.env.AIRTABLE_SETTINGS_TABLE || 'Settings';
const TT_API = 'https://open-api.tiktokglobalshop.com';
const TT_AUTH = 'https://auth.tiktok-shops.com';

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const safeParse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function authed(event) {
  const k = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  return !!process.env.ADMIN_KEY && k === process.env.ADMIN_KEY;
}

/* ---------- Airtable ---------- */
async function at(path, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const t = await r.text();
  const d = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${d.error?.message || d.error?.type || d.error || t}`);
  return d;
}
async function listAll(table, params = {}) {
  const out = []; let offset;
  do {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) [].concat(v).forEach(x => q.append(k, x));
    q.set('pageSize', '100');
    if (offset) q.set('offset', offset);
    const d = await at(`${encodeURIComponent(table)}?${q}`);
    out.push(...d.records); offset = d.offset;
    if (offset) await sleep(210);
  } while (offset);
  return out;
}
// Airtable allows 10 records per write and ~5 requests/sec
async function inBatches(list, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += 10) {
    out.push(...(await fn(list.slice(i, i + 10))));
    if (i + 10 < list.length) await sleep(210);
  }
  return out;
}

const F = { saleId: 'Sale ID', soldAt: 'Sold At', product: 'Product', item: 'Item', price: 'Price', shipCharged: 'Ship Charged', boxCost: 'Box Cost', shipCost: 'Ship Cost', fees: 'Fees', extras: 'Extras', notes: 'Notes', source: 'Source', buyer: 'Buyer', status: 'Status' };
const NUM = ['price', 'shipCharged', 'boxCost', 'shipCost', 'fees'];

function toFields(s) {
  const f = {};
  for (const [k, col] of Object.entries(F)) {
    if (!(k in s)) continue;
    let v = s[k];
    if (k === 'extras') v = v && Object.keys(v).length ? JSON.stringify(v) : '';
    else if (NUM.includes(k)) v = v === '' || v === null || v === undefined || isNaN(v) ? null : Number(v);
    else v = v == null ? '' : String(v);
    f[col] = v;
  }
  return f;
}
function fromRecord(r) {
  const f = r.fields, s = { id: r.id };
  for (const [k, col] of Object.entries(F)) {
    const v = f[col];
    if (k === 'extras') s[k] = safeParse(v) || {};
    else if (NUM.includes(k)) s[k] = v === undefined ? null : v;
    else s[k] = v ?? '';
  }
  return s;
}

async function getKV(key) {
  const q = new URLSearchParams({ filterByFormula: `{Key}='${key}'`, maxRecords: '1' });
  const d = await at(`${encodeURIComponent(SETTINGS)}?${q}`);
  const rec = d.records[0];
  return rec ? { id: rec.id, value: safeParse(rec.fields.Value) } : null;
}
async function setKV(key, value) {
  const ex = await getKV(key);
  const fields = { Key: key, Value: value == null ? '' : JSON.stringify(value) };
  if (ex) return at(`${encodeURIComponent(SETTINGS)}/${ex.id}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
  return at(encodeURIComponent(SETTINGS), { method: 'POST', body: JSON.stringify({ fields }) });
}

/* ---------- TikTok Shop (API version 202309) ---------- */
function ttSign(path, query, body) {
  const secret = process.env.TIKTOK_APP_SECRET;
  const keys = Object.keys(query).filter(k => k !== 'sign' && k !== 'access_token').sort();
  const base = secret + path + keys.map(k => k + query[k]).join('') + (body || '') + secret;
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}
async function ttCall(method, path, query, bodyObj, accessToken) {
  const q = { app_key: process.env.TIKTOK_APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  q.sign = ttSign(path, q, body);
  const r = await fetch(`${TT_API}${path}?${new URLSearchParams(q)}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body: bodyObj ? body : undefined
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`TikTok ${d.code}: ${d.message}`);
  return d.data || {};
}
async function ttTokenCall(path, params) {
  const q = new URLSearchParams({ app_key: process.env.TIKTOK_APP_KEY, app_secret: process.env.TIKTOK_APP_SECRET, ...params });
  const d = await (await fetch(`${TT_AUTH}${path}?${q}`)).json();
  if (d.code !== 0) throw new Error(`TikTok auth ${d.code}: ${d.message}`);
  return d.data;
}
async function ttTokens() {
  const t = (await getKV('tiktok_tokens'))?.value;
  if (!t) throw new Error('TikTok is not connected');
  if (t.accessExpires * 1000 > Date.now() + 5 * 60 * 1000) return t;
  const d = await ttTokenCall('/api/v2/token/refresh', { refresh_token: t.refreshToken, grant_type: 'refresh_token' });
  const nt = { ...t, accessToken: d.access_token, accessExpires: d.access_token_expire_in, refreshToken: d.refresh_token, refreshExpires: d.refresh_token_expire_in };
  await setKV('tiktok_tokens', nt);
  return nt;
}

/* OAuth state: timestamp signed with ADMIN_KEY, so the callback can't be forged */
const stateMake = () => { const ts = String(Date.now()); return `${ts}.${crypto.createHmac('sha256', process.env.ADMIN_KEY).update(ts).digest('hex').slice(0, 32)}`; };
function stateOk(s) {
  const [ts, sig] = String(s || '').split('.');
  if (!ts || !sig || Date.now() - Number(ts) > 15 * 60 * 1000) return false;
  const want = crypto.createHmac('sha256', process.env.ADMIN_KEY).update(ts).digest('hex').slice(0, 32);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

module.exports = { SALES, SETTINGS, json, authed, at, listAll, inBatches, toFields, fromRecord, getKV, setKV, ttCall, ttTokenCall, ttTokens, stateMake, stateOk, sleep };
