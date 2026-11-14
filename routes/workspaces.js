// Personal workspaces: anyone can create their own ("Life", "Семья"…), is its owner, can invite
// people by link (family, friends, colleagues) and switches between it and PulsAura top-left.
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const perms = require('../lib/permissions');
const { makeBackup } = require('../lib/backup');

const router = express.Router();

function createSpace(wsId, name, icon, position) {
  const id = db.prepare('INSERT INTO spaces (name, icon, position, workspace_id) VALUES (?, ?, ?, ?)').run(name, icon, position, wsId).lastInsertRowid;
  ['К выполнению', 'В работе', 'Готово'].forEach((n, i) => db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)').run(id, n, i));
  return id;
}

const newToken = () => crypto.randomBytes(12).toString('base64url');

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const icon = String(req.body.icon || '').trim().slice(0, 8);
  if (!name) return res.redirect('back');
  const wsId = db.prepare('INSERT INTO workspaces (name, icon, owner_id) VALUES (?, ?, ?)').run(name, icon, req.user.id).lastInsertRowid;
  createSpace(wsId, 'Мои дела', '📝', 0); // something to start with
  req.session.ws = wsId;
  res.redirect('/');
});

// Body: ws = 'team' or a workspace id (own or joined).
router.post('/switch', (req, res) => {
  const ws = req.body.ws === 'team' ? null : perms.accessibleWorkspace(req.user, req.body.ws);
  req.session.ws = ws ? ws.id : null;
  res.redirect('/');
});

router.get('/:id', (req, res) => {
  const ws = perms.accessibleWorkspace(req.user, req.params.id);
  if (!ws) return res.status(404).send('Workspace не найден');
  const owner = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(ws.owner_id);
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, m.joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? ORDER BY m.joined_at
  `).all(ws.id);
  const spaceCount = db.prepare('SELECT COUNT(*) AS c FROM spaces WHERE workspace_id = ?').get(ws.id).c;
  const inviteUrl = ws.invite_token ? `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/join/${ws.invite_token}` : null;
  res.render('workspace-settings', {
    workspace: ws, isOwner: ws.my_role === 'owner', owner, members, spaceCount, inviteUrl,
    msg: req.query.msg || '', activeNav: '', title: `Настройки — ${ws.name}`,
  });
});

router.post('/:id/rename', (req, res) => {
  const ws = perms.ownWorkspace(req.user, req.params.id);
  if (!ws) return res.status(404).send('Workspace не найден');
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.redirect(`/workspaces/${ws.id}?msg=noname`);
  db.prepare('UPDATE workspaces SET name = ?, icon = ? WHERE id = ?').run(name, String(req.body.icon || '').trim().slice(0, 8), ws.id);
  res.redirect(`/workspaces/${ws.id}?msg=saved`);
});

// Invite link: create / replace (old link stops working) / turn off.
router.post('/:id/invite', (req, res) => {
  const ws = perms.ownWorkspace(req.user, req.params.id);
  if (!ws) return res.status(404).send('Workspace не найден');
  db.prepare('UPDATE workspaces SET invite_token = ? WHERE id = ?').run(req.body.off ? null : newToken(), ws.id);
  res.redirect(`/workspaces/${ws.id}?msg=${req.body.off ? 'invite_off' : 'invite_new'}`);
});

router.post('/:id/members/:userId/remove', (req, res) => {
  const ws = perms.ownWorkspace(req.user, req.params.id);
  if (!ws) return res.status(404).send('Workspace не найден');
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(ws.id, req.params.userId);
  res.redirect(`/workspaces/${ws.id}?msg=removed`);
});

router.post('/:id/leave', (req, res) => {
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (Number(req.session.ws) === Number(req.params.id)) req.session.ws = null;
  res.redirect('/');
});

// Deletes the workspace with all its spaces and tasks (FK cascade). Snapshot first.
router.post('/:id/delete', async (req, res, next) => {
  try {
  const ws = perms.ownWorkspace(req.user, req.params.id);
  if (!ws) return res.status(404).send('Workspace не найден');
  if (String(req.body.confirm_name || '').trim() !== ws.name) return res.redirect(`/workspaces/${ws.id}?msg=confirm`);
  await makeBackup(db, db.filePath, `before-delete-workspace-${ws.id}`);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
  if (Number(req.session.ws) === ws.id) req.session.ws = null;
  res.redirect('/');
  } catch (err) { next(err); }
});

module.exports = router;
