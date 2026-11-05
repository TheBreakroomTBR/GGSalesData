const { SALES, json, authed, at, listAll, inBatches, toFields, fromRecord } = require('../lib/shared');
const T = encodeURIComponent(SALES);

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    switch (event.httpMethod) {
      case 'GET': {
        const recs = await listAll(SALES);
        return json(200, { records: recs.map(fromRecord) });
      }
      case 'POST': {
        const made = await inBatches(body.records || [], async (chunk) =>
          (await at(T, { method: 'POST', body: JSON.stringify({ typecast: true, records: chunk.map(s => ({ fields: toFields(s) })) }) })).records);
        return json(200, { records: made.map(fromRecord) });
      }
      case 'PATCH': {
        const done = await inBatches(body.records || [], async (chunk) =>
          (await at(T, { method: 'PATCH', body: JSON.stringify({ typecast: true, records: chunk.map(({ id, ...s }) => ({ id, fields: toFields(s) })) }) })).records);
        return json(200, { records: done.map(fromRecord) });
      }
      case 'DELETE': {
        await inBatches(body.ids || [], async (chunk) => {
          const q = new URLSearchParams(); chunk.forEach(id => q.append('records[]', id));
          return (await at(`${T}?${q}`, { method: 'DELETE' })).records;
        });
        return json(200, { ok: true });
      }
      default: return json(405, { error: 'Method not allowed' });
    }
  } catch (e) {
    return json(500, { error: e.message });
  }
};
