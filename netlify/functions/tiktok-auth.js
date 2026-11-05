const { json, authed, getKV, setKV, ttCall, ttTokenCall, stateMake, stateOk } = require('../lib/shared');

const back = (q) => ({ statusCode: 302, headers: { Location: `/?${new URLSearchParams(q)}` }, body: '' });

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  try {
    // 1) TikTok redirects the seller back here after they approve
    if (p.code) {
      if (!stateOk(p.state)) return back({ tiktok: 'error', msg: 'Connection link expired. Try Connect again.' });
      const d = await ttTokenCall('/api/v2/token/get', { auth_code: p.code, grant_type: 'authorized_code' });
      const scopes = d.granted_scopes || [];
      const base = {
        accessToken: d.access_token, accessExpires: d.access_token_expire_in,
        refreshToken: d.refresh_token, refreshExpires: d.refresh_token_expire_in,
        scopes, shopName: d.seller_name || ''
      };
      // Save the login first so we can see what TikTok granted even if the next step fails
      await setKV('tiktok_tokens', base);
      let shops;
      try {
        shops = await ttCall('GET', '/authorization/202309/shops', {}, null, d.access_token);
      } catch (e) {
        return back({ tiktok: 'error', msg: `Step 2 (shop list) failed: ${e.message.slice(0, 120)} | Permissions granted: ${scopes.join(', ') || 'NONE'}` });
      }
      const shop = (shops.shops || [])[0];
      if (!shop) return back({ tiktok: 'error', msg: `No shop found on that TikTok account. Permissions granted: ${scopes.join(', ') || 'NONE'}` });
      await setKV('tiktok_tokens', { ...base, shopCipher: shop.cipher, shopId: shop.id, shopName: shop.name || base.shopName });
      return back({ tiktok: 'connected' });
    }

    if (!authed(event)) return json(401, { error: 'Unauthorized' });

    if (p.action === 'status') {
      const t = (await getKV('tiktok_tokens'))?.value;
      const last = (await getKV('tiktok_last_sync'))?.value;
      if (!t) return json(200, { connected: false });
      if (!t.shopCipher) return json(200, { connected: false, scopes: t.scopes || [], error: `Login saved but no shop linked. Permissions granted: ${(t.scopes || []).join(', ') || 'NONE'}` });
      const alive = t.refreshExpires * 1000 > Date.now();
      return json(200, { connected: alive, shopName: t.shopName, scopes: t.scopes || [], lastSync: last, error: alive ? null : 'TikTok login expired. Connect again.' });
    }
    if (p.action === 'start') {
      if (!process.env.TIKTOK_APP_KEY || !process.env.TIKTOK_APP_SECRET) return json(400, { error: 'Set TIKTOK_APP_KEY and TIKTOK_APP_SECRET in Netlify first' });
      const base = process.env.TIKTOK_AUTH_URL || `https://services.us.tiktokshop.com/open/authorize?service_id=${process.env.TIKTOK_SERVICE_ID || ''}`;
      const url = `${base}${base.includes('?') ? '&' : '?'}state=${encodeURIComponent(stateMake())}`;
      return json(200, { url });
    }
    if (p.action === 'disconnect' && event.httpMethod === 'POST') {
      await setKV('tiktok_tokens', null);
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    if (p.code) return back({ tiktok: 'error', msg: `Step 1 (login) failed: ${e.message}` });
    return json(500, { error: e.message });
  }
};
