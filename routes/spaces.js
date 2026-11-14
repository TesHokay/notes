const express = require('express');
const db = require('../db');
const perms = require('../lib/permissions');
const taskService = require('../lib/task-service');
const dates = require('../lib/dates');
const { makeBackup } = require('../lib/backup');
const { followSpace } = require('../lib/workspace-context');

const router = express.Router();

router.get('/', (req, res) => {
  const spaces = perms.visibleSpaces(req.user, req.ws ? req.ws.id : null);
  res.render('spaces', { spaces, canCreate: req.ws ? req.ws.my_role === 'owner' : Boolean(req.user.is_owner), activeNav: 'spaces', title: 'Пространства' });
});

// In PulsAura only owners create spaces; in a personal workspace — its owner.
router.post('/', (req, res) => {
  const wsId = req.ws ? req.ws.id : null;
  if (wsId ? req.ws.my_role !== 'owner' : !req.user.is_owner) return res.status(403).send('Создавать пространства может только владелец');
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/spaces');
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM spaces WHERE workspace_id IS ?').get(wsId).m;
  const info = db.prepare('INSERT INTO spaces (name, icon, position, workspace_id) VALUES (?, ?, ?, ?)').run(name, (req.body.icon || '').trim(), maxPos + 1, wsId);
  if (!wsId) db.prepare('INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, ?)').run(info.lastInsertRowid, req.user.id, 'manager');
  db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 0)').run(info.lastInsertRowid, 'К выполнению');
  db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 1)').run(info.lastInsertRowid, 'В работе');
  db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 2)').run(info.lastInsertRowid, 'Готово');
  res.redirect(`/spaces/${info.lastInsertRowid}`);
});

function loadBoard(space, user, myRole, filters) {
  const sections = db.prepare('SELECT * FROM sections WHERE space_id = ? ORDER BY position ASC').all(space.id);

  const params = [space.id, filters.completed ? 1 : 0];
  let where = 't.space_id = ? AND t.done = ?';
  if (filters.projectId) { where += ' AND t.project_id = ?'; params.push(filters.projectId); }
  if (filters.leadType) {
    where += " AND t.client_id IN (SELECT id FROM clients WHERE lead_type = ?)";
    params.push(filters.leadType === 'none' ? '' : filters.leadType);
  }
  if (filters.assigneeId) {
    where += ' AND EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id = t.id AND ta2.user_id = ?)';
    params.push(filters.assigneeId);
  }

  const order = filters.completed ? 't.completed_at DESC, t.id DESC' : 't.position ASC, t.id ASC';
  const rows = db.prepare(`${taskService.CARD_SELECT} WHERE ${where} ORDER BY ${order}`).all(...params)
    .filter(t => perms.canSeeTask(user, t, space, myRole));
  const tasks = taskService.enrichForCards(rows);

  const board = sections.map(section => ({ ...section, tasks: tasks.filter(t => t.section_id === section.id) }));
  return { sections, tasks, board };
}

function buildCalendar(monthParam, tasks) {
  const now = new Date();
  let [y, m] = dates.localDate(now).split('-').map(Number);
  const match = /^(\d{4})-(\d{2})$/.exec(monthParam || '');
  if (match) { y = Number(match[1]); m = Number(match[2]); }
  const first = new Date(y, m - 1, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const gridStart = new Date(y, m - 1, 1 - startOffset);
  const byDate = {};
  tasks.forEach(t => { if (t.due_date) (byDate[t.due_date] ||= []).push(t); });
  Object.values(byDate).forEach(list => list.sort((a, b) => (a.due_time || '99:99').localeCompare(b.due_time || '99:99')));
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const iso = dates.calendarDate(d);
    days.push({ iso, day: d.getDate(), inMonth: d.getMonth() === m - 1, tasks: byDate[iso] || [] });
  }
  const trimmed = days.slice(35).every(d => !d.inMonth) ? days.slice(0, 35) : days;
  const pad = n => String(n).padStart(2, '0');
  const prev = new Date(y, m - 2, 1);
  const next = new Date(y, m, 1);
  return {
    title: `${['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'][m - 1]} ${y}`,
    days: trimmed,
    prev: `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`,
    next: `${next.getFullYear()}-${pad(next.getMonth() + 1)}`,
    undated: tasks.filter(t => !t.due_date).length,
  };
}

router.get('/:id', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');

  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!myRole) return res.status(404).send('Пространство не найдено');
  followSpace(req, res, space);

  const filters = {
    projectId: req.query.project ? Number(req.query.project) : null,
    assigneeId: req.query.assignee ? Number(req.query.assignee) : null,
    completed: req.query.completed === '1',
    leadType: ['agency', 'business', 'none'].includes(req.query.type) ? req.query.type : null,
  };
  const view = ['list', 'calendar'].includes(req.query.view) ? req.query.view : 'board';

  const { board, tasks } = loadBoard(space, req.user, myRole, filters);
  const calendar = view === 'calendar' ? buildCalendar(req.query.month, tasks) : null;

  // With default people — the calendar "+" form shows them next to each account.
  const projects = db.prepare(`
    SELECT p.id, p.name,
      (SELECT GROUP_CONCAT(u.name, ', ') FROM project_assignees pa JOIN users u ON u.id = pa.user_id WHERE pa.project_id = p.id) AS people
    FROM projects p WHERE p.space_id = ? AND p.archived = 0 ORDER BY p.name
  `).all(space.id);
  const users = res.locals.allUsers;
  const canManage = myRole === 'owner' || myRole === 'manager';
  const canCreate = myRole !== 'guest' && !filters.completed;

  res.render('space', {
    space, board, tasks, projects, users, myRole, canManage, canCreate, view, filters, calendar,
    month: req.query.month || '', today: dates.localDate(),
    activeNav: `space-${space.id}`, title: space.name, mainClass: 'wide board-page',
  });
});

router.get('/:id/settings', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!myRole || (myRole !== 'owner' && myRole !== 'manager')) return res.status(403).send('Недостаточно прав');
  followSpace(req, res, space);
  const personal = Boolean(space.workspace_id);

  const members = db.prepare(`
    SELECT u.id, u.name, u.email, sm.role
    FROM space_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.space_id = ? AND u.is_owner = 0 ORDER BY u.name
  `).all(space.id);

  const clients = db.prepare('SELECT id, name FROM clients ORDER BY name').all();
  const projects = db.prepare(`
    SELECT p.*, c.name AS client_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
    FROM projects p LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.space_id = ? AND p.archived = 0 ORDER BY p.created_at DESC
  `).all(space.id);
  const projectPeople = {};
  db.prepare('SELECT pa.project_id, pa.user_id FROM project_assignees pa JOIN projects p ON p.id = pa.project_id WHERE p.space_id = ?')
    .all(space.id).forEach(r => (projectPeople[r.project_id] ||= []).push(r.user_id));
  projects.forEach(p => { p.people_ids = projectPeople[p.id] || []; });
  const assignable = perms.assignableUsers(space.workspace_id || null);

  // Owners see every space without a role — listed separately, not offered for adding.
  const owners = db.prepare('SELECT id, name, email FROM users WHERE is_owner = 1 ORDER BY name').all();
  const memberIds = new Set(members.map(m => m.id));
  const otherUsers = db.prepare('SELECT id, name, email FROM users WHERE is_owner = 0 AND is_external = 0 ORDER BY name').all().filter(u => !memberIds.has(u.id));

  res.render('space-settings', {
    space, members, owners, clients, projects, assignable, otherUsers, myRole, personal, msg: req.query.msg || '',
    canDelete: personal ? myRole === 'owner' : Boolean(req.user.is_owner),
    taskCount: db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE space_id = ?').get(space.id).c,
    activeNav: `space-${space.id}`, title: `Настройки — ${space.name}`,
  });
});

router.post('/:id/visibility', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const mode = req.body.task_visibility === 'assignees_and_managers' ? 'assignees_and_managers' : 'all_members';
  db.prepare('UPDATE spaces SET task_visibility = ? WHERE id = ?').run(mode, space.id);
  res.json({ ok: true, task_visibility: mode });
});

router.post('/:id/rename', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).send('Недостаточно прав');

  const name = String(req.body.name || '').trim().slice(0, 80);
  const icon = String(req.body.icon || '').trim().slice(0, 8);
  if (!name) return res.redirect(`/spaces/${space.id}/settings?msg=noname`);
  db.prepare('UPDATE spaces SET name = ?, icon = ? WHERE id = ?').run(name, icon, space.id);
  res.redirect(`/spaces/${space.id}/settings?msg=renamed`);
});

// Owner only. Deletes the space with its columns, cards and project labels (FK cascade);
// clients and users stay. A DB snapshot is taken first so it can be undone from backups.
router.post('/:id/delete', async (req, res, next) => {
  try {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  const personalOwner = perms.personalOwnerOf(space.id);
  if (personalOwner ? personalOwner !== req.user.id : !req.user.is_owner) return res.status(403).send('Удалять пространства может только владелец');
  if (String(req.body.confirm_name || '').trim() !== space.name) return res.redirect(`/spaces/${space.id}/settings?msg=confirm`);

  await makeBackup(db, db.filePath, `before-delete-space-${space.id}`);
  db.prepare('DELETE FROM spaces WHERE id = ?').run(space.id);
  res.redirect('/spaces');
  } catch (err) { next(err); }
});

router.post('/:id/projects', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).send('Недостаточно прав');

  const name = (req.body.name || '').trim();
  const wantsJson = req.is('application/json');
  if (!name) return wantsJson ? res.status(400).json({ error: 'name_required' }) : res.redirect(`/spaces/${space.id}/settings`);

  const info = db.prepare(`
    INSERT INTO projects (space_id, client_id, name, description, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(space.id, req.body.client_id ? Number(req.body.client_id) : null, name, (req.body.description || '').trim(), req.user.id);

  // From the calendar "+" form: a new account/project is created inline and selected right away.
  if (wantsJson) return res.status(201).json({ id: info.lastInsertRowid, name });
  res.redirect(`/spaces/${space.id}/settings`);
});

// ---------- Projects / accounts: rename, default people, delete ----------
function loadProject(req, res) {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  const project = space && db.prepare('SELECT * FROM projects WHERE id = ? AND space_id = ?').get(req.params.pid, space.id);
  if (!project) { res.status(404).send('Не найдено'); return null; }
  if (!perms.canManageSpace(req.user, space.id)) { res.status(403).send('Недостаточно прав'); return null; }
  return { space, project };
}

router.post('/:id/projects/:pid/rename', (req, res) => {
  const ctx = loadProject(req, res);
  if (!ctx) return;
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, ctx.project.id);
  res.redirect(`/spaces/${ctx.space.id}/settings#projects`);
});

// Body (form): user_ids = one or several checkbox values; none = no default people.
router.post('/:id/projects/:pid/people', (req, res) => {
  const ctx = loadProject(req, res);
  if (!ctx) return;
  const ids = [].concat(req.body.user_ids || []).map(Number).filter(uid => uid && perms.canAssign(ctx.space.id, uid));
  db.prepare('DELETE FROM project_assignees WHERE project_id = ?').run(ctx.project.id);
  ids.forEach(uid => db.prepare('INSERT OR IGNORE INTO project_assignees (project_id, user_id) VALUES (?, ?)').run(ctx.project.id, uid));
  res.redirect(`/spaces/${ctx.space.id}/settings#projects`);
});

// Tasks stay — they just lose the label.
router.post('/:id/projects/:pid/delete', (req, res) => {
  const ctx = loadProject(req, res);
  if (!ctx) return;
  db.prepare('DELETE FROM projects WHERE id = ?').run(ctx.project.id);
  res.redirect(`/spaces/${ctx.space.id}/settings#projects`);
});

router.post('/:id/members', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).send('Недостаточно прав');

  const userId = Number(req.body.user_id);
  const role = ['manager', 'member', 'guest'].includes(req.body.role) ? req.body.role : 'member';
  if (!userId || space.workspace_id) return res.redirect(`/spaces/${space.id}/settings`); // personal: owner only

  db.prepare('INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role')
    .run(space.id, userId, role);

  res.redirect(`/spaces/${space.id}/settings`);
});

router.post('/:id/members/:userId/role', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).send('Недостаточно прав');

  const role = ['manager', 'member', 'guest'].includes(req.body.role) ? req.body.role : 'member';
  db.prepare('UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ?').run(role, space.id, req.params.userId);
  res.redirect(`/spaces/${space.id}/settings`);
});

router.post('/:id/members/:userId/remove', (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) return res.status(404).send('Пространство не найдено');
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).send('Недостаточно прав');

  db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(space.id, req.params.userId);
  res.redirect(`/spaces/${space.id}/settings`);
});

module.exports = router;
