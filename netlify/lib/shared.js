const crypto = require('crypto');

const DAYS = process.env.AIRTABLE_DAYS_TABLE || 'Days';
const SETTINGS = process.env.AIRTABLE_SETTINGS_TABLE || 'Settings';
const TZ = process.env.TZ_NAME || 'America/New_York';
const TT_API = 'https://open-api.tiktokglobalshop.com';
const TT_AUTH = 'https://auth.tiktok-shops.com';
const SKIP = ['UNPAID', 'CANCELLED', 'ON_HOLD'];

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const safeParse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const authed = e => !!process.env.ADMIN_KEY && (e.headers['x-admin-key'] || e.headers['X-Admin-Key']) === process.env.ADMIN_KEY;

/* ---------- Dates in your time zone ---------- */
const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const today = () => dayOf(Date.now());

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
async function listAll(table) {
  const out = []; let offset;
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    if (offset) q.set('offset', offset);
    const d = await at(`${encodeURIComponent(table)}?${q}`);
    out.push(...d.records); offset = d.offset;
    if (offset) await sleep(210);
  } while (offset);
  return out;
}
async function inBatches(list, fn) {
  for (let i = 0; i < list.length; i += 10) { await fn(list.slice(i, i + 10)); if (i + 10 < list.length) await sleep(210); }
}
// Writes only the fields you pass; your own columns are never touched
async function upsertDays(rows) {
  await inBatches(rows, c => at(encodeURIComponent(DAYS), {
    method: 'PATCH',
    body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['Date'] }, typecast: true, records: c.map(fields => ({ fields })) })
  }));
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
  return crypto.createHmac('sha256', secret).update(secret + path + keys.map(k => k + query[k]).join('') + (body || '') + secret).digest('hex');
}
async function ttCall(method, path, query, bodyObj, accessToken) {
  const q = { app_key: process.env.TIKTOK_APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  q.sign = ttSign(path, q, body);
  const r = await fetch(`${TT_API}${path}?${new URLSearchParams(q)}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken }, body: bodyObj ? body : undefined
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
  if (!t.shopCipher) throw new Error('TikTok login saved but no shop linked. Connect again.');
  if (t.accessExpires * 1000 > Date.now() + 5 * 60 * 1000) return t;
  const d = await ttTokenCall('/api/v2/token/refresh', { refresh_token: t.refreshToken, grant_type: 'refresh_token' });
  const nt = { ...t, accessToken: d.access_token, accessExpires: d.access_token_expire_in, refreshToken: d.refresh_token, refreshExpires: d.refresh_token_expire_in };
  await setKV('tiktok_tokens', nt);
  return nt;
}
const stateMake = () => { const ts = String(Date.now()); return `${ts}.${crypto.createHmac('sha256', process.env.ADMIN_KEY).update(ts).digest('hex').slice(0, 32)}`; };
function stateOk(s) {
  const [ts, sig] = String(s || '').split('.');
  if (!ts || !sig || Date.now() - Number(ts) > 15 * 60 * 1000) return false;
  const want = crypto.createHmac('sha256', process.env.ADMIN_KEY).update(ts).digest('hex').slice(0, 32);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/* ---------- The sync: daily sales totals only ---------- */
async function syncRange(from, to) {
  const t = await ttTokens();
  const now = Math.floor(Date.now() / 1000);
  // Pull a little wider than the range, then bucket by your local day
  const ge = Math.floor(Date.parse(from + 'T00:00:00Z') / 1000) - 15 * 3600;
  const lt = Math.min(now, Math.floor(Date.parse(addDays(to, 1) + 'T00:00:00Z') / 1000) + 15 * 3600);
  const orders = []; let pageToken = '';
  do {
    const q = { shop_cipher: t.shopCipher, page_size: '100' };
    if (pageToken) q.page_token = pageToken;
    const d = await ttCall('POST', '/order/202309/orders/search', q, { create_time_ge: ge, create_time_lt: lt }, t.accessToken);
    orders.push(...(d.orders || []));
    pageToken = d.next_page_token || '';
  } while (pageToken && orders.length < 5000);

  // Sales = item subtotal (paid, not cancelled). GMV = what the buyer paid minus tax, incl. shipping,
  // and like Seller Center it keeps cancelled/refunded orders in. Unpaid orders count toward neither.
  const totals = {};
  for (const o of orders) {
    if (o.status === 'UNPAID') continue;
    const day = dayOf(Number(o.create_time) * 1000);
    if (day < from || day > to) continue;
    const p = o.payment || {};
    const t = (totals[day] ||= { sales: 0, orders: 0, gmv: 0 });
    const tax = p.tax != null ? Number(p.tax) : Number(p.product_tax || 0) + Number(p.shipping_fee_tax || 0);
    t.gmv += Number(p.total_amount || 0) - tax;
    if (SKIP.includes(o.status)) continue;
    t.sales += Number(p.sub_total ?? p.total_amount ?? 0);
    t.orders++;
  }
  const r2 = n => Math.round(n * 100) / 100;
  const rows = Object.entries(totals).map(([d, v]) => ({ Date: d, Sales: r2(v.sales), GMV: r2(v.gmv), Orders: v.orders }));
  await upsertDays(rows);
  await setKV('tiktok_last_sync', new Date().toISOString());
  return { from, to, orders: orders.length, days: rows };
}

module.exports = { DAYS, json, authed, at, listAll, upsertDays, getKV, setKV, ttCall, ttTokenCall, ttTokens, stateMake, stateOk, syncRange, today, addDays };
