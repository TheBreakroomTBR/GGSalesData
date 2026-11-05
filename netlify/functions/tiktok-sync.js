const { json, authed, syncRange, today, addDays } = require('../lib/shared');

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    const yest = addDays(today(), -1);
    const from = b.from || yest, to = b.to || yest;
    if (from > to) return json(400, { error: 'Start date is after end date' });
    if (Date.parse(to) - Date.parse(from) > 31 * 86400000) return json(400, { error: 'Pull 31 days or fewer at a time' });
    return json(200, await syncRange(from, to));
  } catch (e) { return json(500, { error: e.message }); }
};
