// Telegram Mini App login: initData signature check and safe redirects.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyInitData, safeNext } = require('../lib/telegram-auth');

const TOKEN = '123456:TEST-token';

function sign(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 777, first_name: 'Даня' });

test('valid initData returns the Telegram user', () => {
  const u = verifyInitData(sign({ auth_date: String(now), query_id: 'q1', user }), TOKEN);
  assert.strictEqual(u.id, 777);
});

test('tampered, foreign-signed or stale initData is rejected', () => {
  const good = sign({ auth_date: String(now), user });
  assert.strictEqual(verifyInitData(good.replace('777', '778'), TOKEN), null, 'changed user id');
  assert.strictEqual(verifyInitData(sign({ auth_date: String(now), user }, '999:other'), TOKEN), null, 'other bot');
  assert.strictEqual(verifyInitData(sign({ auth_date: String(now - 2 * 86400), user }), TOKEN), null, 'too old');
  assert.strictEqual(verifyInitData('', TOKEN), null);
  assert.strictEqual(verifyInitData(good, ''), null, 'no bot token configured');
});

test('safeNext allows only same-site paths', () => {
  assert.strictEqual(safeNext('/tasks/5'), '/tasks/5');
  assert.strictEqual(safeNext('//evil.com'), '/');
  assert.strictEqual(safeNext('/\\evil.com'), '/');
  assert.strictEqual(safeNext('https://evil.com'), '/');
  assert.strictEqual(safeNext(undefined), '/');
});
