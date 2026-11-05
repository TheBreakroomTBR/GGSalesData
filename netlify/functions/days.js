const { DAYS, json, authed, listAll, upsertDays } = require('../lib/shared');
const EDITABLE = ['Sales', 'Shipping', 'Fees'];

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  try {
    if (event.httpMethod === 'GET') {
      const recs = await listAll(DAYS);
      return json(200, { baseId: process.env.AIRTABLE_BASE_ID, days: recs.map(r => ({ id: r.id, ...r.fields })) });
    }
    // Set day-level numbers by hand: { date, sales } or { date, fields: { Shipping, Fees } }. null clears a cell.
    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return json(400, { error: 'Need a date' });
      const f = { Date: b.date };
      if (b.sales !== undefined) f.Sales = Number(b.sales);
      for (const k of EDITABLE) if (b.fields && k in b.fields) f[k] = b.fields[k] === null || b.fields[k] === '' ? null : Number(b.fields[k]);
      if (Object.keys(f).length === 1) return json(400, { error: 'Nothing to save' });
      await upsertDays([f]);
      return json(200, { ok: true, fields: f });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (e) { return json(500, { error: e.message }); }
};
