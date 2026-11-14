const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const perms = require('../lib/permissions');
const { renderToString } = require('../lib/render');
const overview = require('../lib/team-overview');

const router = express.Router();

function greeting(name) {
  const hour = dates.hour();
  const word = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  return `${word}, ${name.split(' ')[0]}`;
}

// "My tasks" is a live query over task_assignees + subtasks.assignee_id —
// not a copy of tasks. Active = task not done (and for subtasks: subtask
// not done and its parent not done).
// Scope: team = PulsAura tasks assigned to the person; wsIds = personal workspaces to include,
// where "mine" = assigned to me or to nobody (a solo workspace rarely bothers with assignees).
// Home shows everything at once (PulsAura + all my workspaces), each row marked with its workspace.
function loadMyTasks(userId, { completed = false, team = true, wsIds = [] } = {}) {
  const done = completed ? 1 : 0;
  const wsList = wsIds.map(Number).filter(Boolean);
  const inWs = wsList.length ? `s.workspace_id IN (${wsList.join(',')})` : '0';
  const WS_COLS = 'w.name AS ws_name, w.icon AS ws_icon, s.workspace_id AS ws_id';
  const tasks = db.prepare(`
    SELECT t.id, t.id AS link_id, NULL AS subtask_id, t.kind, t.meeting_url, t.title, NULL AS parent_title, t.due_date, t.due_time, t.priority,
      t.repeat_rule, t.completed_at, p.name AS project_name, c.name AS client_name, s.name AS space_name, s.id AS space_id, s.card_mode, 0 AS is_subtask, ${WS_COLS}
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN clients c ON c.id = t.client_id
    JOIN spaces s ON s.id = t.space_id
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    WHERE t.done = ? AND (
      (${team ? 1 : 0} AND s.workspace_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?))
      OR (${inWs} AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?)
                      OR NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)))
    )
  `).all(done, userId, userId);

  const subtasks = db.prepare(`
    SELECT sub.id, t.id AS link_id, sub.id AS subtask_id, sub.title, t.title AS parent_task_title, sub.due_date, sub.due_time, 'medium' AS priority,
      NULL AS repeat_rule, sub.completed_at, p.name AS project_name, c.name AS client_name, s.name AS space_name, s.id AS space_id, s.card_mode, 1 AS is_subtask, ${WS_COLS}
    FROM subtasks sub
    JOIN tasks t ON t.id = sub.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN clients c ON c.id = t.client_id
    JOIN spaces s ON s.id = t.space_id
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    WHERE EXISTS (SELECT 1 FROM subtask_assignees sa WHERE sa.subtask_id = sub.id AND sa.user_id = ?)
      AND sub.done = ? ${completed ? '' : 'AND t.done = 0'}
      AND ((${team ? 1 : 0} AND s.workspace_id IS NULL) OR ${inWs})
  `).all(userId, done);

  // People for quick assignee pickers + whether the viewer may edit the task.
  if (tasks.length) {
    const ph = tasks.map(() => '?').join(',');
    const rows = db.prepare(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id IN (${ph}) ORDER BY u.name`).all(...tasks.map(t => t.id));
    tasks.forEach(t => { t.people = rows.filter(r => r.task_id === t.id).map(r => ({ id: r.id, name: r.name })); });
  }
  subtasks.forEach(s => { s.parent_title = s.card_mode === 'client' ? require('../lib/view-helpers').dealTitle(s.client_name, s.parent_task_title) : s.parent_task_title; });
  require('../lib/task-service').attachSubtaskPeople(subtasks);
  const all = [...tasks, ...subtasks];
  if (completed) return all.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).slice(0, 100);
  return all.sort((a, b) => {
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date) || (a.due_time || '99:99').localeCompare(b.due_time || '99:99');
  });
}

function markEditable(tasks, viewer) {
  const roles = {};
  tasks.forEach(t => {
    if (!(t.space_id in roles)) roles[t.space_id] = perms.getSpaceRole(viewer, t.space_id);
    const r = roles[t.space_id];
    // Subtask fields are editable by anyone who sees the task; task fields by managers.
    t.can_edit = t.is_subtask ? true : (r === 'owner' || r === 'manager');
  });
  return tasks;
}

// Home sections by due date. Dragging a row into Сегодня / Завтра / Послезавтра / Позже / Без срока
// sets its date (see home-lists.ejs, data-drop-offset).
// The viewer's own order of Home rows: { 'task:5': 0, 'subtask:9': 1, … }.
function loadHomeOrder(userId) {
  const map = {};
  db.prepare('SELECT kind, item_id, position FROM home_order WHERE user_id = ?').all(userId)
    .forEach(r => { map[`${r.kind}:${r.item_id}`] = r.position; });
  return map;
}

function bucketTasks(tasks, order = {}) {
  const today = dates.localDate();
  const tomorrow = dates.addDays(today, 1);
  const dayAfter = dates.addDays(today, 2);
  const buckets = { overdue: [], today: [], tomorrow: [], dayAfter: [], later: [], noDate: [] };
  tasks.forEach(t => {
    if (!t.due_date) return buckets.noDate.push(t);
    const { state } = dates.dueInfo(t.due_date, t.due_time);
    if (state === 'overdue') buckets.overdue.push(t);
    else if (t.due_date === today) buckets.today.push(t);
    else if (t.due_date === tomorrow) buckets.tomorrow.push(t);
    else if (t.due_date === dayAfter) buckets.dayAfter.push(t);
    else buckets.later.push(t);
  });
  // Rows the person placed by hand go in that order; the rest keep date/time order after them.
  Object.values(buckets).forEach(list => {
    const key = (t, i) => order[`${t.is_subtask ? 'subtask' : 'task'}:${t.id}`] ?? (1e6 + i);
    const keyed = list.map((t, i) => [key(t, i), t]).sort((a, b) => a[0] - b[0]);
    list.splice(0, list.length, ...keyed.map(k => k[1]));
  });
  return buckets;
}

// PulsAura counters + per-person load (personal workspaces are nobody else's business).
function teamStats() {
  const items = overview.loadTeamItems();
  return {
    ...overview.teamCounts(items),
    perPerson: overview.perPerson(items).map(p => ({ id: p.id, name: p.name, open_tasks: p.total, overdue: p.overdue.length })),
  };
}

router.get('/', async (req, res) => {
  const completed = req.query.completed === '1';
  // Home = everything that's mine: PulsAura + every workspace I own or was invited to.
  const myWs = res.locals.myWorkspaces || [];
  const tasks = markEditable(loadMyTasks(req.user.id, { completed, team: !req.user.is_external, wsIds: myWs.map(w => w.id) }), req.user);
  // Mark rows with their workspace only when there's more than one to tell apart.
  const showWs = myWs.length > 0 && !req.user.is_external || myWs.length > 1;
  const locals = { completed, buckets: completed ? null : bucketTasks(tasks, loadHomeOrder(req.user.id)), completedList: completed ? tasks : [], canCheck: true, showWs, canReorder: true };

  const team = req.user.is_owner && !req.user.is_external && !completed ? teamStats() : null;
  // Scoped refresh after a change (drawer, drag, checkbox): the lists + the owner's counters.
  if (req.query.partial === 'lists') {
    return res.send((team ? await renderToString(req, 'partials/home-stats', { team }) : '') + await renderToString(req, 'partials/home-lists', locals));
  }

  res.render('dashboard', {
    ...locals,
    greeting: greeting(req.user.name),
    team,
    activeNav: 'dashboard',
    title: 'Главная',
  });
});

// Save the viewer's order of one Home section. Body: { items: [{ kind: 'task'|'subtask', id }] } top→bottom.
router.post('/home/order', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 500) : [];
  const up = db.prepare(`INSERT INTO home_order (user_id, kind, item_id, position) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, kind, item_id) DO UPDATE SET position = excluded.position`);
  items.forEach((it, i) => {
    if ((it.kind === 'task' || it.kind === 'subtask') && Number.isInteger(Number(it.id))) up.run(req.user.id, it.kind, Number(it.id), i);
  });
  res.json({ ok: true });
});

// Owners: the whole team — by person, or all overdue / today / unassigned.
router.get('/overview', (req, res) => {
  if (!req.user.is_owner || req.user.is_external) return res.status(403).send('Доступно только владельцам');
  const items = overview.loadTeamItems();
  const f = ['overdue', 'today', 'unassigned', 'done'].includes(req.query.f) ? req.query.f : 'people';
  const period = { today: 1, week: 7, month: 30 }[req.query.p] ? req.query.p : 'week';
  const done = f === 'done' ? overview.loadTeamDone({ today: 1, week: 7, month: 30 }[period]) : [];
  const list = f === 'unassigned' ? items.filter(overview.isUnassigned)
    : f === 'people' || f === 'done' ? [] : items.filter(i => i.bucket === f);
  res.render('overview', {
    f, list, done, period, doneBy: overview.doneByPerson(done),
    counts: overview.teamCounts(items), people: f === 'people' ? overview.perPerson(items) : [],
    activeNav: 'dashboard', title: 'Сводка команды',
  });
});

router.get('/team/:userId', (req, res) => {
  if (!req.user.is_owner) return res.status(403).send('Доступно только владельцам');
  const person = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.userId);
  if (!person) return res.status(404).send('Пользователь не найден');

  const completed = req.query.completed === '1';
  const tasks = markEditable(loadMyTasks(person.id, { completed }), req.user); // PulsAura only
  const locals = { buckets: completed ? null : bucketTasks(tasks), completed, completedList: completed ? tasks : [], canCheck: false, showWs: false };
  if (req.query.partial === 'lists') return renderToString(req, 'partials/home-lists', locals).then(html => res.send(html));
  res.render('team-member', { person, ...locals, activeNav: 'dashboard', title: person.name });
});

module.exports = router;
