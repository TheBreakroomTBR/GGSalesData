// Passes Claude's connector requests through to EchoTik's MCP server, adding your EchoTik login.
// Add to Claude as a custom connector: https://YOUR-SITE.netlify.app/echotik/<MCP_KEY>
const crypto = require('crypto');
const UPSTREAM = process.env.ECHOTIK_MCP_URL || 'https://mcp.echotik.live/mcp';

function keyOk(event) {
  const want = process.env.MCP_KEY || '';
  if (want.length < 16) return false;
  const got = (event.queryStringParameters || {}).key || (event.path || '').split('/').filter(Boolean).pop() || '';
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
const hdr = (h, k) => h[k] ?? h[k.toLowerCase()];

exports.handler = async (event) => {
  const json = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!keyOk(event)) return { statusCode: 401, headers: json, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (!process.env.ECHOTIK_USERNAME || !process.env.ECHOTIK_PASSWORD)
    return { statusCode: 500, headers: json, body: JSON.stringify({ error: 'Set ECHOTIK_USERNAME and ECHOTIK_PASSWORD in Netlify' }) };
  if (!['POST', 'DELETE'].includes(event.httpMethod)) return { statusCode: 405, headers: { ...json, Allow: 'POST' }, body: '' };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-EchoTik-Username': process.env.ECHOTIK_USERNAME,
    'X-EchoTik-Password': process.env.ECHOTIK_PASSWORD
  };
  const sid = hdr(event.headers, 'Mcp-Session-Id'); if (sid) headers['Mcp-Session-Id'] = sid;
  const ver = hdr(event.headers, 'Mcp-Protocol-Version'); if (ver) headers['Mcp-Protocol-Version'] = ver;

  try {
    const r = await fetch(UPSTREAM, {
      method: event.httpMethod, headers,
      body: event.httpMethod === 'POST' ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : undefined
    });
    let body = await r.text();
    // EchoTik may answer as an event stream; turn it back into plain JSON for Claude
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      const msgs = body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
      body = msgs.length === 1 ? msgs[0] : msgs.length ? `[${msgs.join(',')}]` : '';
    }
    const out = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const upSid = r.headers.get('mcp-session-id'); if (upSid) out['Mcp-Session-Id'] = upSid;
    return { statusCode: body ? r.status : (r.status === 200 ? 202 : r.status), headers: out, body };
  } catch (e) {
    return { statusCode: 502, headers: json, body: JSON.stringify({ error: `EchoTik unreachable: ${e.message}` }) };
  }
};
