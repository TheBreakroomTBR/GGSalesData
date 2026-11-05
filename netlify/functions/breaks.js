const { json, authed, at, listAll } = require('../lib/shared');
const TABLE = process.env.AIRTABLE_BREAKS_TABLE || 'Breaks';
const T = encodeURIComponent(TABLE);

// Clean what the page sends: numbers stay numbers, blanks clear the cell
function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === 'id') continue;
    out[k] = v === '' || v === undefined ? null : v;
  }
  return out;
}

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  try {
    const b = event.body ? JSON.parse(event.body) : {};
    switch (event.httpMethod) {
      case 'GET': {
        const recs = await listAll(TABLE);
        return json(200, { breaks: recs.map(r => ({ id: r.id, ...r.fields })) });
      }
      case 'POST': {
        const d = await at(T, { method: 'POST', body: JSON.stringify({ typecast: true, records: [{ fields: clean(b.fields) }] }) });
        return json(200, { record: { id: d.records[0].id, ...d.records[0].fields } });
      }
      case 'PATCH': {
        if (!b.id) return json(400, { error: 'Missing id' });
        const d = await at(T, { method: 'PATCH', body: JSON.stringify({ typecast: true, records: [{ id: b.id, fields: clean(b.fields) }] }) });
        return json(200, { record: { id: d.records[0].id, ...d.records[0].fields } });
      }
      case 'DELETE': {
        if (!b.id) return json(400, { error: 'Missing id' });
        await at(`${T}/${b.id}`, { method: 'DELETE' });
        return json(200, { ok: true });
      }
      default: return json(405, { error: 'Method not allowed' });
    }
  } catch (e) { return json(500, { error: e.message }); }
};
