// Security middleware: headers, login brute-force protection, optional
// outer HTTP Basic Auth "gate", startup config checks.
const crypto = require('node:crypto');

const isProd = process.env.NODE_ENV === 'production';

function checkConfig() {
  const secret = process.env.SESSION_SECRET || '';
  if (isProd && (secret.length < 32 || secret === 'change-me-in-production')) {
    console.error('[security] SESSION_SECRET не задан или слишком короткий (нужно 32+ символа). Запуск остановлен.');
    console.error('[security] Сгенерировать: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
  }
  if (!isProd && !secret) console.warn('[security] SESSION_SECRET не задан — ок для локальной разработки, но НЕ для сервера.');
}

function headers(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (isProd) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
}

// Persistent limiter: failures and lock windows survive server/Worker restarts.
function createLimiter({ max, windowMs }) {
  const hits = require('./transient-store').createStore(`login:${max}:${windowMs}`, windowMs);
  return {
    blocked(key) {
      const v = hits.get(key);
      return Boolean(v && v.reset > Date.now() && v.count >= max);
    },
    fail(key) {
      const now = Date.now();
      const v = hits.get(key);
      if (!v || v.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else hits.set(key, { ...v, count: v.count + 1 });
    },
    reset(key) { hits.delete(key); },
  };
}

const loginLimiter = createLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const ipLimiter = createLimiter({ max: 40, windowMs: 15 * 60 * 1000 });

// Optional outer gate: set BASIC_AUTH_USER + BASIC_AUTH_PASSWORD to require a
// shared browser login before anything (incl. the login page) is shown.
function basicAuthGate() {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !pass) return (req, res, next) => next();
  const expected = Buffer.from(`${user}:${pass}`);
  return (req, res, next) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    const given = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (ok) return next();
    res.set('WWW-Authenticate', 'Basic realm="PulsAura", charset="UTF-8"');
    res.status(401).send('Требуется авторизация');
  };
}

module.exports = { isProd, checkConfig, headers, loginLimiter, ipLimiter, basicAuthGate };
