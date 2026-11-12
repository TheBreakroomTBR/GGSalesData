// MCP server so Claude can read your TikTok Shop LIVE analytics + P&L data directly.
// Add to Claude as a custom connector: https://YOUR-SITE.netlify.app/mcp/<MCP_KEY>
// Read-only: it can only GET, or POST to */search endpoints. It cannot change anything in your shop.
const crypto = require('crypto');
const { ttCall, ttTokens, getKV, listAll, DAYS, today, addDays } = require('../lib/shared');

const BREAKS = process.env.AIRTABLE_BREAKS_TABLE || 'Breaks';
const PROTOCOL = '2025-06-18';

/* ---------- auth: secret key in the URL ---------- */
function keyOk(event) {
  const want = process.env.MCP_KEY || '';
  if (want.length < 16) return false;
  const fromPath = (event.path || '').split('/').filter(Boolean).pop();
  const got = (event.queryStringParameters || {}).key || fromPath || '';
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* ---------- TikTok helpers ---------- */
async function tt(method, path, query = {}, body = null) {
  const t = await ttTokens();
  return ttCall(method, path, { shop_cipher: t.shopCipher, ...query }, body, t.accessToken);
}
// TikTok versions its analytics paths; try the known ones in order and report what happened
async function ttTry(method, paths, query, body) {
  const errors = [];
  for (const p of paths) {
    try { return { path: p, data: await tt(method, p, query, body) }; }
    catch (e) {
      errors.push(`${p}: ${e.message}`);
      if (/105005|scope|unauthori[sz]ed|access denied/i.test(e.message)) break; // permission problem, no point trying more
    }
  }
  const err = new Error(errors.join('\n')); err.tried = errors; throw err;
}
const V = ['202512', '202511', '202510', '202509', '202508', '202507', '202506', '202505', '202406', '202405'];
const TZ = process.env.TZ_NAME || 'America/New_York';
const clock = s => new Date(Number(s) * 1000).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const ymdOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function range(a) {
  const to = ymdOk(a.end_date) ? a.end_date : today();
  const from = ymdOk(a.start_date) ? a.start_date : addDays(to, -13);
  return { start_date_ge: from, end_date_lt: addDays(to, 1) };
}


/* ---------- EchoTik (competitor LIVEs), called through EchoTik's own MCP server ---------- */
async function echotik(tool, args) {
  const url = process.env.ECHOTIK_MCP_URL || 'https://mcp.echotik.live/mcp';
  if (!process.env.ECHOTIK_USERNAME) throw new Error('Set ECHOTIK_USERNAME and ECHOTIK_PASSWORD in Netlify');
  const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'X-EchoTik-Username': process.env.ECHOTIK_USERNAME, 'X-EchoTik-Password': process.env.ECHOTIK_PASSWORD };
  const parse = async r => { const t = await r.text(); const ct = r.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) return t ? JSON.parse(t) : {};
    const line = t.split('\n').filter(l => l.startsWith('data:')).pop(); return line ? JSON.parse(line.slice(5)) : {}; };
  if (!echotik.sid) {
    const r = await fetch(url, { method: 'POST', headers: base, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'helmet-live', version: '1' } } }) });
    await parse(r); echotik.sid = r.headers.get('mcp-session-id') || '';
    await fetch(url, { method: 'POST', headers: { ...base, ...(echotik.sid ? { 'Mcp-Session-Id': echotik.sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  }
  const r = await fetch(url, { method: 'POST', headers: { ...base, ...(echotik.sid ? { 'Mcp-Session-Id': echotik.sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const d = await parse(r);
  if (d.error) { echotik.sid = null; throw new Error(`EchoTik: ${d.error.message}`); }
  const text = (d.result?.content || []).map(c => c.text || '').join('');
  try { return JSON.parse(text); } catch { throw new Error(`EchoTik: ${text.slice(0, 200)}`); }
}
function roomSummary(room) {
  const r = room || {}, mins = r.start_time ? Math.round((Date.now() / 1000 - r.start_time) / 60) : null;
  return { title: r.title, viewers_now: r.user_count, total_entered: r.stats?.total_user, likes: r.like_count, shares: r.stats?.share_count,
    minutes_live: mins, entered_per_hour: mins ? Math.round((r.stats?.total_user || 0) / mins * 60) : null,
    likes_per_minute: mins ? Math.round((r.like_count || 0) / mins) : null,
    followers: r.owner?.follow_info?.follower_count, topic: r.hashtag?.title, third_party_encoder: !!r.live_type_third_party,
    shop_products: r.has_commerce_goods };
}

/* ---------- tools ---------- */
const TOOLS = [
  {
    name: 'shop_status',
    description: 'Which TikTok shop is connected, which API permissions (scopes) the login has, and when sales were last synced. Call first if anything fails.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const t = (await getKV('tiktok_tokens'))?.value;
      if (!t) return { connected: false, fix: 'Connect TikTok on the Setup page of the P&L site.' };
      return { connected: !!t.shopCipher, shop: t.shopName, scopes: t.scopes || 'not recorded', lastSync: (await getKV('tiktok_last_sync'))?.value || null,
        loginExpires: t.refreshExpires ? new Date(t.refreshExpires * 1000).toISOString() : null };
    }
  },
  {
    name: 'live_sessions',
    description: 'List LIVE sessions with performance (viewers, views, watch time, concurrent viewers, comments, likes, shares, new followers, product impressions/clicks, CTR, orders, GMV) for a date range. Dates YYYY-MM-DD; default last 14 days.',
    inputSchema: { type: 'object', properties: {
      start_date: { type: 'string' }, end_date: { type: 'string' },
      page_size: { type: 'number', description: 'max 100, default 50' }, page_token: { type: 'string' } } },
    run: async (a) => ttTry('GET', V.map(v => `/analytics/${v}/shop_lives/performance`),
      { ...range(a), page_size: String(Math.min(+a.page_size || 50, 100)), currency: 'USD', ...(a.page_token ? { page_token: a.page_token } : {}) })
  },
  {
    name: 'live_overview',
    description: 'Totals across all LIVEs for a date range (aggregate viewers, GMV, conversion). Dates YYYY-MM-DD.',
    inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } },
    run: async (a) => ttTry('GET', V.map(v => `/analytics/${v}/shop_lives/overview_performance`), { ...range(a), currency: 'USD', granularity: 'ALL' })
  },
  {
    name: 'live_minute_by_minute',
    description: 'Minute-by-minute stats for one LIVE rolled up into 5-minute rows (feed impressions, views, enter rate = views/impressions, viewers, comments, clicks, orders, GMV). Use to find when traffic or entry drops. Needs live_id from live_sessions.',
    inputSchema: { type: 'object', properties: { live_id: { type: 'string' }, bucket_minutes: { type: 'number', description: 'minutes per row, default 5' }, page_token: { type: 'string' } }, required: ['live_id'] },
    run: async (a) => {
      // Pull every page, then roll up into buckets so the reply stays small
      const bucket = Math.max(1, Math.min(+a.bucket_minutes || 5, 60));
      let token = a.page_token || '', path, all = [];
      for (let i = 0; i < 40; i++) {
        const r = await ttTry('GET', V.map(v => `/analytics/${v}/shop_lives/${encodeURIComponent(a.live_id)}/performance_per_minutes`), { currency: 'USD', ...(token ? { page_token: token } : {}) });
        path = r.path; all.push(...(r.data?.performance?.intervals || [])); token = r.data?.next_page_token || '';
        if (!token) break;
      }
      all.sort((x, y) => x.start_time - y.start_time);
      const rows = [];
      for (let i = 0; i < all.length; i += bucket) {
        const g = all.slice(i, i + bucket), sum = f => g.reduce((t, x) => t + Number(f(x) || 0), 0);
        const imp = sum(x => x.traffic?.impressions), views = sum(x => x.traffic?.views);
        rows.push({ time: clock(g[0].start_time), impressions: imp, views, enter_rate: imp ? +(views / imp).toFixed(2) : 0,
          avg_viewers: Math.round(sum(x => x.traffic?.viewers) / g.length), comments: sum(x => x.interactions?.comments), likes: sum(x => x.interactions?.likes),
          new_followers: sum(x => x.interactions?.new_followers), product_clicks: sum(x => x.traffic?.product_clicks), orders: sum(x => x.sales?.sku_orders),
          gmv: +sum(x => x.sales?.gmv?.amount).toFixed(2) });
      }
      return { path, minutes: all.length, bucket_minutes: bucket, rows };
    }
  },
  {
    name: 'live_products',
    description: 'Product-level results inside one LIVE (impressions, clicks, orders, GMV per product). Needs live_id.',
    inputSchema: { type: 'object', properties: { live_id: { type: 'string' } }, required: ['live_id'] },
    run: async (a) => ttTry('GET', V.map(v => `/analytics/${v}/shop_lives/${encodeURIComponent(a.live_id)}/products_performance`), { currency: 'USD', page_size: '100' })
  },
  {
    name: 'shop_performance',
    description: 'Shop-wide daily performance (GMV, orders, visitors, GMV from LIVE vs video vs product card). Dates YYYY-MM-DD.',
    inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' },
      granularity: { type: 'string', enum: ['1D', 'ALL'] } } },
    run: async (a) => ttTry('GET', V.map(v => `/analytics/${v}/shop/performance`), { ...range(a), granularity: a.granularity || '1D', currency: 'USD' })
  },
  {
    name: 'tiktok_api_get',
    description: 'Escape hatch: call any read-only TikTok Shop Partner API endpoint (GET, or POST to a path ending in /search). Use when a path above has changed version. shop_cipher, app_key, timestamp and sign are added automatically.',
    inputSchema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET', 'POST'] }, path: { type: 'string', description: 'e.g. /analytics/202509/shop_lives/performance' },
      query: { type: 'object', description: 'query params as strings' }, body: { type: 'object' } }, required: ['path'] },
    run: async (a) => {
      const m = (a.method || 'GET').toUpperCase();
      if (!/^\/[a-z_]+\/\d{6}\//.test(a.path || '')) throw new Error('Path must look like /area/YYYYMM/...');
      if (m === 'POST' && !/\/search$/.test(a.path)) throw new Error('Read-only: POST is only allowed to */search endpoints');
      if (/token|authorization\/|\/delete|\/cancel|\/update|\/create|\/activate|\/deactivate/i.test(a.path)) throw new Error('That endpoint is blocked (not read-only)');
      const q = Object.fromEntries(Object.entries(a.query || {}).map(([k, v]) => [k, String(v)]));
      return { path: a.path, data: await tt(m, a.path, q, m === 'POST' ? (a.body || {}) : null) };
    }
  },
  {
    name: 'competitor_lives',
    description: 'Who is LIVE right now for a keyword (default "football helmets") and a short snapshot of each room via EchoTik: viewers now, total entered, entered per hour, likes and likes per minute, shares, minutes live, followers, topic, whether they stream from an encoder like OBS. Use to compare against our live in real time.',
    inputSchema: { type: 'object', properties: { keyword: { type: 'string' }, region: { type: 'string' }, max_rooms: { type: 'number', description: 'default 8' } } },
    run: async (a) => {
      const s = await echotik('get_api_v3_realtime_live_search', { keyword: a.keyword || 'football helmets', region: a.region || 'US' });
      const items = (s.data?.data || s.data || []).filter(x => x?.lives?.author?.room_id_str).slice(0, Math.min(+a.max_rooms || 8, 15));
      const out = [];
      for (const it of items) {
        const au = it.lives.author;
        try {
          const d = await echotik('get_api_v3_realtime_live_detail', { room_id: au.room_id_str, user_id: au.uid });
          out.push({ account: au.unique_id, ...roomSummary(d.data?.data || d.data) });
        } catch (e) { out.push({ account: au.unique_id, title: au.room_title, error: e.message.slice(0, 120) }); }
      }
      return { keyword: a.keyword || 'football helmets', checked_at: new Date().toISOString(), rooms: out };
    }
  },
  {
    name: 'fee_breakdown',
    description: "Adds up every fee, tax, shipping and discount line across a statement's transactions (one per order), so you can see commission vs transaction fee vs affiliate vs label costs. Statements have thousands of rows: each call reads up to max_pages x 100 rows and returns running totals plus next_page_token. Pass the returned totals back in as 'carry' with that token to continue. Get statement ids from tiktok_api_get /finance/202309/statements.",
    inputSchema: { type: 'object', properties: {
      statement_id: { type: 'string' }, page_token: { type: 'string' }, max_pages: { type: 'number', description: 'default 8' },
      carry: { type: 'object', description: 'totals object from the previous call' } }, required: ['statement_id'] },
    run: async (a) => {
      const sums = { ...(a.carry?.sums || {}) }; let rows = a.carry?.rows || 0, types = { ...(a.carry?.types || {}) };
      let token = a.page_token || '', head = a.carry?.statement || null;
      const add = (prefix, obj) => { for (const [k, v] of Object.entries(obj || {})) {
        if (v && typeof v === 'object') add(`${prefix}${k}.`, v);
        else { const n = Number(v); if (n) sums[prefix + k] = Math.round(((sums[prefix + k] || 0) + n) * 100) / 100; } } };
      const pages = Math.max(1, Math.min(+a.max_pages || 8, 12));
      for (let i = 0; i < pages; i++) {
        const r = await ttTry('GET', ['202501', '202507', '202509'].map(v => `/finance/${v}/statements/${encodeURIComponent(a.statement_id)}/statement_transactions`),
          { page_size: '100', sort_field: 'order_create_time', ...(token ? { page_token: token } : {}) });
        const d = r.data || {};
        if (!head) head = { id: d.id, create_time: d.create_time, total_count: d.total_count, settlement: d.total_settlement_amount, payable: d.payable_amount, reserve: d.total_reserve_amount, breakdown: d.total_settlement_breakdown };
        for (const t of d.transactions || []) {
          rows++; types[t.type] = (types[t.type] || 0) + 1;
          add('fee.', t.fee_tax_breakdown?.fee); add('tax.', t.fee_tax_breakdown?.tax);
          add('ship.', t.shipping_cost_breakdown); add('rev.', t.revenue_breakdown); add('pay.', t.supplementary_component);
        }
        token = d.next_page_token || '';
        if (!token || !(d.transactions || []).length) { token = ''; break; }
      }
      return { done: !token, next_page_token: token || null, carry: { statement: head, rows, types, sums } };
    }
  },
  {
    name: 'pl_days',
    description: "The P&L tracker's own data from Airtable: each day's GMV, item sales, orders, shipping, fees, plus every breaker row (Sam, Kris) with Gridiron Grail / Pup Lids boxes and box cost. Dates YYYY-MM-DD; default last 30 days.",
    inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } },
    run: async (a) => {
      const to = ymdOk(a.end_date) ? a.end_date : today(), from = ymdOk(a.start_date) ? a.start_date : addDays(to, -29);
      const inR = r => r.Date >= from && r.Date <= to;
      const [days, breaks, cfg] = await Promise.all([listAll(DAYS), listAll(BREAKS).catch(() => []), getKV('daily_config')]);
      return { from, to, settings: cfg?.value || null,
        days: days.map(r => r.fields).filter(inR).sort((x, y) => x.Date.localeCompare(y.Date)),
        breaks: breaks.map(r => r.fields).filter(inR).sort((x, y) => x.Date.localeCompare(y.Date)) };
    }
  }
];

/* ---------- JSON-RPC / MCP (stateless Streamable HTTP) ---------- */
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const MAX = 90000;

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'helmet-live-tiktok', version: '1.0.0' },
        instructions: 'TikTok Shop LIVE analytics and the Helmet Live P&L. Start with shop_status. If an analytics tool returns a path/version error, retry with tiktok_api_get using a different YYYYMM version. A 105005 error means the analytics scope is missing on the TikTok app or the shop needs to re-authorize.' });
    case 'ping': return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true } })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool ${params.name}`);
      try {
        let text = JSON.stringify(await tool.run(params.arguments || {}), null, 1);
        if (text.length > MAX) text = text.slice(0, MAX) + '\n…(truncated; narrow the date range or page)';
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default: return fail(id, -32601, `Method not found: ${method}`);
  }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!keyOk(event)) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: { ...headers, Allow: 'POST' }, body: JSON.stringify({ error: 'Use POST' }) };
  let msg;
  try { msg = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || ''); }
  catch { return { statusCode: 400, headers, body: JSON.stringify(fail(null, -32700, 'Parse error')) }; }
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
  if (!out || (Array.isArray(out) && !out.length)) return { statusCode: 202, headers, body: '' };
  return { statusCode: 200, headers, body: JSON.stringify(out) };
};
