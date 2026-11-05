const { DAYS, json, authed, listAll, upsertDays } = require('../lib/shared');

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  try {
    if (event.httpMethod === 'GET') {
      const recs = await listAll(DAYS);
      return json(200, { baseId: process.env.AIRTABLE_BASE_ID, days: recs.map(r => ({ id: r.id, ...r.fields })) });
    }
    // Manual entry: log a day's sales by hand (only Date + Sales are written)
    if (event.httpMethod === 'POST') {
      const { date, sales } = JSON.parse(event.body || '{}');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || isNaN(sales)) return json(400, { error: 'Need a date and a sales number' });
      await upsertDays([{ Date: date, Sales: Number(sales) }]);
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (e) { return json(500, { error: e.message }); }
};
