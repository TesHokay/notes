const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { loginLimiter, ipLimiter } = require('../lib/security');
const { verifyInitData, safeNext } = require('../lib/telegram-auth');

const router = express.Router();

router.get('/login', (req, res) => {
  const next = safeNext(req.query.next);
  if (req.user) return res.redirect(next);
  res.render('login', { error: null, next });
});

// ---------- Join a personal workspace by invite link ----------
// Logged in: confirm and join. Not logged in: register right here (a guest account that never
// sees PulsAura) or log in and come back. Owners/existing members just get switched to it.
function inviteWorkspace(token) {
  if (!token || !/^[\w-]{10,40}$/.test(token)) return null;
  return db.prepare(`
    SELECT w.*, u.name AS owner_name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.invite_token = ?
  `).get(token) || null;
}

function joinWorkspace(req, ws, userId) {
  if (ws.owner_id !== userId) db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id) VALUES (?, ?)').run(ws.id, userId);
  req.session.ws = ws.id;
}

router.get('/join/:token', (req, res) => {
  const ws = inviteWorkspace(req.params.token);
  if (!ws) return res.status(404).render('join', { ws: null, token: '', user: req.user, error: null, values: {} });
  res.render('join', { ws, token: req.params.token, user: req.user, error: null, values: {} });
});

router.post('/join/:token', (req, res) => {
  const ws = inviteWorkspace(req.params.token);
  if (!ws) return res.status(404).render('join', { ws: null, token: '', user: req.user, error: null, values: {} });
  if (req.user) {
    joinWorkspace(req, ws, req.user.id);
    return res.redirect('/');
  }
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const fail = error => res.status(400).render('join', { ws, token: req.params.token, user: null, error, values: { name, email } });
  if (ipLimiter.blocked(req.ip)) return fail('Слишком много попыток. Подождите 15 минут.');
  if (!name || !/^[^\s@]+@[^\s@]+$/.test(email) || password.length < 8) return fail('Заполните имя, email и пароль (минимум 8 символов).');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    ipLimiter.fail(req.ip);
    return fail('Такой email уже зарегистрирован — нажмите «Войти» ниже и откройте ссылку ещё раз.');
  }
  const userId = db.prepare('INSERT INTO users (name, email, password_hash, is_external) VALUES (?, ?, ?, 1)')
    .run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid;
  req.session.userId = userId;
  joinWorkspace(req, ws, userId);
  res.redirect('/');
});

// ---------- Telegram Mini App login ----------
// Bot buttons open APP_URL/tg?next=/tasks/5 inside Telegram. The page hands Telegram's signed
// initData to POST /auth/telegram; if the Telegram account is linked in a profile, the person
// is logged in without a password and sent on to `next`.
router.get('/tg', (req, res) => {
  res.render('tg-login', { next: safeNext(req.query.next) });
});

router.post('/auth/telegram', (req, res) => {
  if (ipLimiter.blocked(req.ip)) return res.status(429).json({ error: 'too_many' });
  const tgUser = verifyInitData(String(req.body.initData || ''), process.env.TELEGRAM_BOT_TOKEN);
  if (!tgUser) {
    ipLimiter.fail(req.ip);
    return res.status(401).json({ error: 'invalid' });
  }
  // In a private chat with the bot, chat id == user id — that's what profile linking stored.
  const user = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(String(tgUser.id));
  if (!user) return res.status(403).json({ error: 'not_linked' });
  req.session.userId = user.id;
  res.json({ ok: true, next: safeNext(req.body.next) });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `${email}|${req.ip}`;
  const next = safeNext(req.body.next);
  if (loginLimiter.blocked(key) || ipLimiter.blocked(req.ip)) {
    return res.status(429).render('login', { error: 'Слишком много попыток входа. Подождите 15 минут.', next });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    loginLimiter.fail(key);
    ipLimiter.fail(req.ip);
    return res.status(401).render('login', { error: 'Неверный email или пароль', next });
  }

  loginLimiter.reset(key);
  req.session.userId = user.id;
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('signup', { error: null, values: {} });
});

router.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const inviteCode = (req.body.invite_code || '').trim();

  const validCode = db.prepare("SELECT value FROM settings WHERE key = 'invite_code'").get();

  const fail = (error) => res.status(400).render('signup', { error, values: { name, email } });

  if (ipLimiter.blocked(req.ip)) return res.status(429).render('signup', { error: 'Слишком много попыток. Подождите 15 минут.', values: { name, email } });
  if (!name || !email || password.length < 8) return fail('Заполните имя, email и пароль (мин. 8 символов)');
  if (!validCode || inviteCode !== validCode.value) {
    ipLimiter.fail(req.ip);
    return fail('Неверный инвайт-код. Спросите его у администратора команды.');
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(name, email, hash);
    req.session.userId = info.lastInsertRowid;
    res.redirect('/');
  } catch (e) {
    fail('Пользователь с таким email уже существует');
  }
});

module.exports = router;
