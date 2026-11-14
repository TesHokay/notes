const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

function render(req, res, extra = {}) {
  const users = db.prepare('SELECT id, name, email, is_owner, can_see_clients, telegram_chat_id, created_at FROM users WHERE is_external = 0 ORDER BY created_at').all();
  const invite = db.prepare("SELECT value FROM settings WHERE key = 'invite_code'").get();
  const spaces = db.prepare('SELECT id, name, icon FROM spaces WHERE workspace_id IS NULL ORDER BY position').all();
  const memberships = {};
  db.prepare(`
    SELECT sm.user_id, sm.role, s.id AS space_id, s.name, s.icon
    FROM space_members sm JOIN spaces s ON s.id = sm.space_id ORDER BY s.position
  `).all().forEach(m => (memberships[m.user_id] ||= []).push(m));
  res.render('users', { users, spaces, memberships, error: null, notice: null, inviteCode: invite ? invite.value : null, activeNav: 'users', title: 'Команда', ...extra });
}

router.get('/', (req, res) => {
  const pwUser = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(req.query.u) || 0);
  const notice = req.query.pw === 'ok' && pwUser ? `Пароль для «${pwUser.name}» изменён.` : null;
  const error = req.query.pw === 'short' ? 'Пароль не изменён: нужно минимум 8 символов.' : null;
  render(req, res, { notice, error });
});

router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || password.length < 8) {
    return render(req, res, { error: 'Заполните имя, email и пароль (мин. 8 символов)' });
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (name, email, password_hash, is_owner) VALUES (?, ?, ?, ?)')
      .run(name, email, hash, req.body.is_owner ? 1 : 0);
    res.redirect('/users');
  } catch (e) {
    render(req, res, { error: 'Пользователь с таким email уже существует' });
  }
});

router.post('/:id/owner', (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.redirect('/users');
  db.prepare('UPDATE users SET is_owner = ? WHERE id = ?').run(req.body.is_owner ? 1 : 0, req.params.id);
  res.redirect('/users');
});

router.post('/:id/clients', (req, res) => {
  db.prepare('UPDATE users SET can_see_clients = ? WHERE id = ?').run(req.body.can_see_clients === '1' ? 1 : 0, req.params.id);
  res.redirect('/users');
});

// Space membership right from the Team page (same data as space → Settings → members).
const ROLES = ['manager', 'member', 'guest'];
router.post('/:id/spaces', (req, res) => {
  const spaceId = Number(req.body.space_id);
  const role = ROLES.includes(req.body.role) ? req.body.role : 'member';
  if (spaceId && db.prepare('SELECT 1 FROM spaces WHERE id = ? AND workspace_id IS NULL').get(spaceId)) {
    db.prepare('INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role')
      .run(spaceId, req.params.id, role);
  }
  res.redirect('/users');
});

// Personal Sales pipeline for a salesperson: a client-mode space "Sales · Имя" with the same columns
// as the main Sales (the first client-mode PulsAura space), the person added as its manager (so they can import Excel and bulk-move cards).
router.post('/:id/sales-space', (req, res) => {
  const person = db.prepare('SELECT id, name FROM users WHERE id = ? AND is_external = 0').get(req.params.id);
  if (!person) return res.redirect('/users');
  const template = db.prepare("SELECT * FROM spaces WHERE card_mode = 'client' AND workspace_id IS NULL ORDER BY position, id LIMIT 1").get();
  const stages = template
    ? db.prepare('SELECT name FROM sections WHERE space_id = ? ORDER BY position').all(template.id).map(s => s.name)
    : ['Новый лид', 'Контакт', 'КП / Оффер', 'Follow-up', 'Клиент', 'Hold / Вернуться', 'Неактуально'];
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM spaces WHERE workspace_id IS NULL').get().m;
  const spaceId = db.prepare("INSERT INTO spaces (name, icon, position, task_visibility, card_mode) VALUES (?, '💼', ?, 'all_members', 'client')")
    .run(`Sales · ${person.name}`, maxPos + 1).lastInsertRowid;
  stages.forEach((n, i) => db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)').run(spaceId, n, i));
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'manager')").run(spaceId, person.id);
  res.redirect(`/spaces/${spaceId}`);
});

router.post('/:id/spaces/:spaceId/remove', (req, res) => {
  db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(req.params.spaceId, req.params.id);
  res.redirect('/users');
});

router.post('/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.redirect('/users');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/users');
});

router.post('/invite-code/regenerate', (req, res) => {
  const code = crypto.randomBytes(4).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('invite_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(code);
  res.redirect('/users');
});

router.post('/:id/password', (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.redirect('/users?pw=short');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.redirect(`/users?pw=ok&u=${Number(req.params.id)}`);
});

module.exports = router;
