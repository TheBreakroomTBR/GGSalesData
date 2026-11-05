const { json, authed, getKV, setKV } = require('../lib/shared');

exports.handler = async (event) => {
  if (!authed(event)) return json(401, { error: 'Unauthorized' });
  try {
    if (event.httpMethod === 'GET') return json(200, { config: (await getKV('config'))?.value || null });
    if (event.httpMethod === 'PUT') { await setKV('config', JSON.parse(event.body || '{}')); return json(200, { ok: true }); }
    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
