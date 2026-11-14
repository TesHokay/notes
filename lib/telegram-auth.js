// Telegram Mini App login: verifies the initData string Telegram hands to a web app opened from
// our bot (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
// The signature is an HMAC keyed by the bot token, so nobody without the token can forge it.
const crypto = require('node:crypto');

// Returns the Telegram user ({ id, first_name, ... }) or null if the data is invalid / too old.
function verifyInitData(initData, botToken, maxAgeSec = 24 * 60 * 60, nowSec = Math.floor(Date.now() / 1000)) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// Only same-site paths ("/tasks/5"), never "//evil.com" or "https://…".
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

module.exports = { verifyInitData, safeNext };
