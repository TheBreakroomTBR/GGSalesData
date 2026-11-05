const { SALES, json, authed, at, listAll, inBatches, toFields, getKV, setKV, ttCall, ttTokens } = require('../lib/shared');
const T = encodeURIComponent(SALES);
const SKIP = ['UNPAID', 'CANCELLED', 'ON_HOLD'];

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const { days = 7 } = JSON.parse(event.body || '{}');
    const t = await ttTokens();
    if (t.scopes && t.scopes.length && !t.scopes.includes('seller.order.info'))
      return json(400, { error: `Your TikTok login doesn't include order access (seller.order.info). It has: ${t.scopes.join(', ') || 'none'}. Add Order Information in Partner Center, then Disconnect and Connect again.` });
    const now = Math.floor(Date.now() / 1000);
    const since = now - Math.min(Math.max(1, Number(days) || 7), 90) * 86400;

    // Pull orders page by page
    const orders = []; let pageToken = '';
    do {
      const q = { shop_cipher: t.shopCipher, page_size: '50' };
      if (pageToken) q.page_token = pageToken;
      const d = await ttCall('POST', '/order/202309/orders/search', q, { create_time_ge: since, create_time_lt: now }, t.accessToken);
      orders.push(...(d.orders || []));
      pageToken = d.next_page_token || '';
    } while (pageToken && orders.length < 3000);

    // Product rules from the app's settings
    const cfg = (await getKV('config'))?.value || {};
    const products = cfg.products || [];
    const matchProduct = (name) => products.find(p => p.match && name.toLowerCase().includes(String(p.match).toLowerCase()))?.name || '';

    // One row per box (line item)
    const rows = [];
    for (const o of orders) {
      const items = o.line_items || [];
      items.forEach((li, i) => {
        const name = [li.product_name, li.sku_name].filter(x => x && x !== 'Default').join(' - ');
        rows.push({
          saleId: `TT-${o.id}-${i}`,
          soldAt: new Date(Number(o.create_time) * 1000).toISOString(),
          item: name,
          product: matchProduct(name),
          price: Number(li.sale_price ?? li.original_price ?? 0),
          shipCharged: i === 0 ? Number(o.payment?.shipping_fee || 0) : 0,
          buyer: o.recipient_address?.name || '',
          status: o.status || '',
          source: 'tiktok'
        });
      });
    }

    // Split into new rows and ones already logged
    const existing = await listAll(SALES, { 'fields[]': ['Sale ID'], filterByFormula: `{Source}='tiktok'` });
    const idMap = new Map(existing.map(r => [r.fields['Sale ID'], r.id]));
    const keep = rows.filter(r => !SKIP.includes(r.status));
    const toCreate = keep.filter(r => !idMap.has(r.saleId));
    // Updates only touch TikTok-owned fields, so your cost edits and product picks stay
    const toUpdate = keep.filter(r => idMap.has(r.saleId)).map(r => ({ id: idMap.get(r.saleId), price: r.price, shipCharged: r.shipCharged, status: r.status }));
    // Orders cancelled after being logged get flagged rather than deleted
    const cancelled = rows.filter(r => SKIP.includes(r.status) && idMap.has(r.saleId)).map(r => ({ id: idMap.get(r.saleId), status: r.status, price: 0 }));

    await inBatches(toCreate, async (c) => (await at(T, { method: 'POST', body: JSON.stringify({ typecast: true, records: c.map(s => ({ fields: toFields(s) })) }) })).records);
    await inBatches(toUpdate.concat(cancelled), async (c) => (await at(T, { method: 'PATCH', body: JSON.stringify({ typecast: true, records: c.map(({ id, ...s }) => ({ id, fields: toFields(s) })) }) })).records);
    await setKV('tiktok_last_sync', new Date().toISOString());

    return json(200, { orders: orders.length, created: toCreate.length, updated: toUpdate.length, cancelled: cancelled.length });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
