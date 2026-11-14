const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  const mySpaces = user.is_owner
    ? db.prepare('SELECT *, NULL AS role FROM spaces WHERE workspace_id IS NULL ORDER BY position').all()
    : db.prepare(`
        SELECT s.*, sm.role FROM spaces s
        JOIN space_members sm ON sm.space_id = s.id
        WHERE sm.user_id = ? ORDER BY s.position
      `).all(req.user.id);
  res.render('profile', { profileUser: user, botUsername, mySpaces, pwMessage: req.query.pw || '', infoMessage: req.query.info || '', activeNav: 'profile', title: 'Профиль' });
});

router.post('/info', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) return res.redirect('/profile?info=invalid');
  const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
  if (taken) return res.redirect('/profile?info=taken');
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.user.id);
  res.redirect('/profile?info=ok');
});

router.post('/telegram/link-code', (req, res) => {
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('UPDATE users SET telegram_link_code = ? WHERE id = ?').run(code, req.user.id);
  res.redirect('/profile');
});

router.post('/telegram/unlink', (req, res) => {
  db.prepare('UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = ?').run(req.user.id);
  res.redirect('/profile');
});

router.post('/password', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!bcrypt.compareSync(current, user.password_hash)) return res.redirect('/profile?pw=wrong');
  if (next.length < 8) return res.redirect('/profile?pw=short');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), user.id);
  res.redirect('/profile?pw=ok');
});

module.exports = router;
