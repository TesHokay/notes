const express = require('express');
const db = require('../db');
const perms = require('../lib/permissions');
const telegram = require('../lib/telegram');
const taskService = require('../lib/task-service');
const dates = require('../lib/dates');
const trash = require('../lib/trash');
const { renderToString } = require('../lib/render');
const { LEAD_TYPES, parseLeadType } = require('../lib/view-helpers');

const router = express.Router();

function loadTaskContext(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return {};
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(task.space_id);
  return { task, space };
}

// Resolves task + space and checks read access. Sends the error response
// itself and returns null when access is denied.
function requireVisibleTask(req, res, taskId) {
  const { task, space } = loadTaskContext(taskId);
  if (!task) { res.status(404).json({ error: 'not_found' }); return null; }
  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!perms.canSeeTask(req.user, task, space, myRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return { task, space, myRole, canManage: myRole === 'owner' || myRole === 'manager' };
}

function renderCard(req, taskId, space) {
  const t = taskService.loadCardTask(taskId);
  return renderToString(req, 'partials/task-card', { t, cardMode: space.card_mode, canEdit: perms.canManageSpace(req.user, space.id) });
}

function loadSubtask(id) {
  const s = db.prepare('SELECT s.* FROM subtasks s WHERE s.id = ?').get(id);
  return s ? taskService.attachSubtaskPeople([s])[0] : null;
}

// ---------- Create task (inline quick-add in a column) ----------

router.post('/sections/:sectionId/tasks', async (req, res) => {
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(req.params.sectionId);
  if (!section) return res.status(404).json({ error: 'section_not_found' });
  const myRole = perms.getSpaceRole(req.user, section.space_id);
  if (!myRole || myRole === 'guest') return res.status(403).json({ error: 'forbidden' });

  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(section.space_id);

  let clientId = req.body.client_id ? Number(req.body.client_id) : null;
  if (!clientId && space.card_mode === 'client') {
    // Client-mode board: the card title IS a client name — reuse an
    // existing client with that exact name instead of creating a duplicate.
    const existing = taskService.findClientForSpace(title, space.id);
    if (existing) {
      clientId = existing.id;
    } else {
      const info = db.prepare('INSERT INTO clients (name) VALUES (?)').run(title);
      clientId = info.lastInsertRowid;
      db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'created', 'Клиент создан из карточки Sales')").run(clientId, req.user.id);
    }
  }

  const placeTop = req.body.placement === 'top';
  const taskId = taskService.transaction(() => {
    let position;
    if (placeTop) {
      db.prepare('UPDATE tasks SET position = position + 1 WHERE section_id = ?').run(section.id);
      position = 0;
    } else {
      position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM tasks WHERE section_id = ?').get(section.id).m;
    }
    const info = db.prepare(`
      INSERT INTO tasks (space_id, section_id, project_id, client_id, title, description, priority, due_date, due_time, created_by, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      section.space_id, section.id,
      req.body.project_id ? Number(req.body.project_id) : null,
      clientId, title, (req.body.description || '').trim(),
      ['low', 'medium', 'high'].includes(req.body.priority) ? req.body.priority : 'medium',
      dates.isValidDate(req.body.due_date) ? req.body.due_date : null,
      dates.isValidTime(req.body.due_time) ? req.body.due_time : null,
      req.user.id, position
    );
    return info.lastInsertRowid;
  });

  let assigneeIds = (Array.isArray(req.body.assignee_ids) ? req.body.assignee_ids.map(Number).filter(Boolean) : [])
    .filter(uid => perms.canAssign(space.id, uid));
  // Nobody picked + a project/account with default people → they get it.
  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  if (!assigneeIds.length && projectId) {
    assigneeIds = db.prepare('SELECT pa.user_id FROM project_assignees pa JOIN projects p ON p.id = pa.project_id WHERE p.id = ? AND p.space_id = ?')
      .all(projectId, space.id).map(r => r.user_id).filter(uid => perms.canAssign(space.id, uid));
  }
  const insertAssignee = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  assigneeIds.forEach(uid => insertAssignee.run(taskId, uid));
  taskService.logTaskEvent(taskId, req.user.id, 'created', `Создана в «${section.name}»`);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assigneeIds.filter(uid => uid !== req.user.id).forEach(uid => telegram.notifyAssigned(uid, task, space.name, req.user.name));

  res.status(201).json({ task, html: await renderCard(req, taskId, space) });
});

// Same task for several accounts (projects) — the drawer's account ticks. Each copy keeps the
// title, description, date, status column and subtasks; people = the account's default people,
// otherwise the same people as the original.
router.post('/tasks/:id/copy-to-projects', (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });
  const projectIds = [...new Set((Array.isArray(req.body.project_ids) ? req.body.project_ids : []).map(Number))]
    .filter(pid => pid && pid !== task.project_id && db.prepare('SELECT 1 FROM projects WHERE id = ? AND space_id = ?').get(pid, space.id));
  if (!projectIds.length) return res.status(400).json({ error: 'no_projects' });

  const ownPeople = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id).map(r => r.user_id);
  const subs = db.prepare('SELECT * FROM subtasks WHERE task_id = ? AND done = 0 ORDER BY position, id').all(task.id);
  const created = [];
  taskService.transaction(() => {
    for (const pid of projectIds) {
      const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM tasks WHERE section_id = ?').get(task.section_id).m;
      const id = db.prepare(`
        INSERT INTO tasks (space_id, section_id, project_id, title, description, priority, due_date, due_time, kind, meeting_url, repeat_rule, created_by, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(space.id, task.section_id, pid, task.title, task.description || '', task.priority || 'medium', task.due_date, task.due_time,
        task.kind || 'task', task.meeting_url || null, task.repeat_rule || null, req.user.id, position).lastInsertRowid;
      const defaults = db.prepare('SELECT user_id FROM project_assignees WHERE project_id = ?').all(pid).map(r => r.user_id);
      (defaults.length ? defaults : ownPeople).filter(uid => perms.canAssign(space.id, uid))
        .forEach(uid => db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, uid));
      subs.forEach((s, i) => {
        const sid = db.prepare('INSERT INTO subtasks (task_id, title, due_date, due_time, position, done) VALUES (?, ?, ?, ?, ?, 0)')
          .run(id, s.title, s.due_date, s.due_time, i).lastInsertRowid;
        taskService.setSubtaskAssignees(sid, taskService.subtaskAssigneeIds(s.id));
      });
      const pname = db.prepare('SELECT name FROM projects WHERE id = ?').get(pid).name;
      taskService.logTaskEvent(id, req.user.id, 'created', `Копия задачи для аккаунта «${pname}»`);
      created.push({ id, project: pname });
    }
  });
  created.forEach(c => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(c.id);
    db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(c.id).map(r => r.user_id)
      .filter(uid => uid !== req.user.id).forEach(uid => telegram.notifyAssigned(uid, t, space.name, req.user.name));
  });
  res.status(201).json({ ok: true, created });
});

// ---------- Task detail (drawer) ----------

router.get('/tasks/:id', async (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).send('Задача не найдена');

  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!perms.canSeeTask(req.user, task, space, myRole)) return res.status(403).send('У вас нет доступа к этой задаче');

  const partial = req.query.partial === '1';
  // Full-page hits (Telegram links, old bookmarks): open the task as a
  // drawer on top of its board, like Asana does, when the user can see the board.
  if (!partial && myRole) return res.redirect(`/spaces/${space.id}?task=${task.id}`);

  const project = task.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) : null;
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(task.section_id);
  const sections = db.prepare('SELECT id, name FROM sections WHERE space_id = ? ORDER BY position').all(space.id);
  // Named salesClient, not client: EJS mishandles a top-level render local
  // literally called "client" — avoid the name.
  const salesClient = task.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(task.client_id) : null;

  const comments = db.prepare(`
    SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at ASC, c.id ASC
  `).all(task.id);

  const subtasks = taskService.attachSubtaskPeople(db.prepare(`
    SELECT s.* FROM subtasks s WHERE s.task_id = ? ORDER BY s.position ASC, s.id ASC
  `).all(task.id));

  const assignees = db.prepare(`
    SELECT u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id
    WHERE ta.task_id = ? ORDER BY u.name
  `).all(task.id);

  // Activity: task events + (for Sales cards) the client's timeline, newest first.
  const taskEvents = db.prepare(`
    SELECT e.type, e.body, e.created_at, u.name AS author_name FROM task_events e
    LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ?
  `).all(task.id);
  const clientEvents = salesClient ? db.prepare(`
    SELECT e.type, e.body, e.created_at, u.name AS author_name FROM client_events e
    LEFT JOIN users u ON u.id = e.user_id WHERE e.client_id = ?
      AND e.type NOT IN ('stage_change', 'action_done', 'action_reopened', 'completed', 'reopened')
  `).all(salesClient.id) : [];
  const activity = [...taskEvents, ...clientEvents].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const projects = db.prepare('SELECT id, name FROM projects WHERE space_id = ? AND archived = 0 ORDER BY name').all(space.id);
  // PulsAura staff, or the owner + members of the personal workspace.
  const users = perms.assignableUsers(space.workspace_id || null);
  const canManage = myRole === 'owner' || myRole === 'manager';
  const linked = salesClient ? db.prepare(`
    SELECT t.id, t.title, t.done, s.name AS section_name, sp.name AS space_name, 'deal' AS rel
    FROM tasks t JOIN sections s ON s.id = t.section_id JOIN spaces sp ON sp.id = t.space_id
    WHERE t.client_id = ? AND t.id != ? ORDER BY t.done ASC, t.id ASC
  `).all(salesClient.id, task.id).map(l => ({ ...l, title: req.app.locals.fmt.dealTitle(salesClient.name, l.title) })) : db.prepare(`
    SELECT t.id, t.title, t.done, s.name AS section_name, CASE WHEN t.id = ? THEN 'parent' ELSE 'child' END AS rel
    FROM tasks t JOIN sections s ON s.id = t.section_id
    WHERE t.id = ? OR t.split_from_task_id = ? ORDER BY t.id
  `).all(task.split_from_task_id || 0, task.split_from_task_id || 0, task.id);

  const locals = {
    linked,
    task, project, section, sections, salesClient, space, comments, subtasks, assignees, users, projects,
    activity, canManage, canMove: Boolean(myRole && myRole !== 'guest'),
    focusSubtask: req.query.focus_subtask ? Number(req.query.focus_subtask) : null,
  };

  if (partial) return res.send(await renderToString(req, 'partials/task/detail', locals));

  // Standalone page for people who can see this task but not its board.
  res.render('task', { ...locals, activeNav: '', title: task.title, mainClass: 'narrow' });
});

router.get('/tasks/:id/card', async (req, res) => {
  const ctx = requireVisibleTask(req, res, req.params.id);
  if (!ctx) return;
  const task = db.prepare('SELECT id, done, section_id FROM tasks WHERE id = ?').get(ctx.task.id);
  res.json({ ...task, html: await renderCard(req, ctx.task.id, ctx.space) });
});

// ---------- Update task fields ----------

const ALLOWED_FIELDS = {
  title: v => typeof v === 'string' && v.trim().length > 0,
  description: v => typeof v === 'string',
  priority: v => ['low', 'medium', 'high'].includes(v),
  due_date: v => v === null || dates.isValidDate(v),
  due_time: v => v === null || dates.isValidTime(v),
  project_id: v => v === null || Number.isInteger(v),
  kind: v => v === 'task' || v === 'meeting',
  meeting_url: v => v === null || (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v) && v.length < 500),
  repeat_rule: v => v === null || Object.prototype.hasOwnProperty.call(require('../lib/recurrence').RULES, v),
};
const PRIORITY_LABEL = { low: 'Низкий', medium: 'Средний', high: 'Высокий' };

router.patch('/tasks/:id', (req, res) => {
  const ctx = requireVisibleTask(req, res, req.params.id);
  if (!ctx) return;
  const { task } = ctx;

  const fieldsRequested = Object.keys(req.body);
  const onlyTogglingDone = fieldsRequested.every(f => f === 'done');
  if (!onlyTogglingDone && !ctx.canManage) return res.status(403).json({ error: 'forbidden' });

  const updates = [];
  const values = [];
  for (const [field, validate] of Object.entries(ALLOWED_FIELDS)) {
    if (!(field in req.body)) continue;
    let value = req.body[field];
    if ((field === 'due_date' || field === 'due_time' || field === 'project_id' || field === 'meeting_url' || field === 'repeat_rule') && !value) value = null;
    if (field === 'meeting_url' && value && !/^https?:\/\//i.test(value.trim())) value = 'https://' + value.trim();
    if (field === 'meeting_url' && value) value = value.trim();
    if (field === 'project_id' && value) value = Number(value);
    if (field === 'title' && typeof value === 'string') value = value.trim();
    if (!validate(value)) return res.status(400).json({ error: `invalid_${field}` });
    updates.push(`${field} = ?`);
    values.push(value);
  }

  // A date is required for a time: clearing the date clears the time too.
  if ('due_date' in req.body && !req.body.due_date && !('due_time' in req.body)) updates.push('due_time = NULL');
  if (updates.length) {
    if ('due_date' in req.body || 'due_time' in req.body) updates.push('due_notified = 0', 'reminded_60 = 0', 'reminded_10 = 0');
    updates.push("updated_at = datetime('now')");
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values, task.id);
  }

  // Completing a recurring task spawns the next one — the board then renders it.
  const spawnedId = 'done' in req.body ? taskService.setTaskDone(task, Boolean(Number(req.body.done)), req.user.id) : null;
  if (!updates.length && !('done' in req.body)) return res.status(400).json({ error: 'no_fields' });

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);

  // Activity log for the fields people care about.
  if (updated.title !== task.title) taskService.logTaskEvent(task.id, req.user.id, 'renamed', `Название: ${updated.title}`);
  if (updated.due_date !== task.due_date || updated.due_time !== task.due_time) {
    const due = dates.dueInfo(updated.due_date, updated.due_time);
    taskService.logTaskEvent(task.id, req.user.id, 'due', updated.due_date ? `Срок: ${due.full}` : 'Срок убран');
  }
  if (updated.priority !== task.priority) taskService.logTaskEvent(task.id, req.user.id, 'priority', `Приоритет: ${PRIORITY_LABEL[updated.priority]}`);
  if (updated.project_id !== task.project_id) {
    const p = updated.project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(updated.project_id) : null;
    taskService.logTaskEvent(task.id, req.user.id, 'project', p ? `Проект: ${p.name}` : 'Проект убран');
  }
  if (updated.kind !== task.kind) taskService.logTaskEvent(task.id, req.user.id, 'kind', updated.kind === 'meeting' ? 'Стала созвоном' : 'Стала обычной задачей');
  if (updated.meeting_url !== task.meeting_url && updated.meeting_url) taskService.logTaskEvent(task.id, req.user.id, 'meeting_url', 'Ссылка на созвон обновлена');
  if (updated.repeat_rule !== task.repeat_rule) {
    const { RULES } = require('../lib/recurrence');
    taskService.logTaskEvent(task.id, req.user.id, 'repeat', updated.repeat_rule ? `Повтор: ${RULES[updated.repeat_rule].toLowerCase()}` : 'Повтор выключен');
  }
  if (task.client_id) db.prepare("UPDATE clients SET last_activity_at = datetime('now') WHERE id = ?").run(task.client_id);

  // Meeting participants hear about reschedules / becoming a meeting.
  if (updated.kind === 'meeting' && updated.due_date) {
    const becameMeeting = task.kind !== 'meeting';
    const moved = updated.due_date !== task.due_date || updated.due_time !== task.due_time;
    if (becameMeeting || moved) {
      const ctx = loadTaskContext(task.id);
      db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id)
        .filter(a => a.user_id !== req.user.id)
        .forEach(a => becameMeeting
          ? telegram.notifyAssigned(a.user_id, updated, ctx.space.name, req.user.name)
          : telegram.notifyMeetingMoved(a.user_id, updated, req.user.name));
    }
  }

  res.json({ ...updated, spawned_id: spawnedId });
});

// "Add to calendar" file for a meeting (Google / Apple / Outlook all import .ics).
router.get('/tasks/:id/ics', (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).send('Не найдено');
  if (!perms.canSeeTask(req.user, task, space, perms.getSpaceRole(req.user, space.id))) return res.status(403).send('Нет доступа');
  if (!task.due_date) return res.status(400).send('У созвона нет даты');
  const [y, m, d] = task.due_date.split('-').map(Number);
  const [hh, mm] = (task.due_time || '10:00').split(':').map(Number);
  const start = new Date(y, m - 1, d, hh, mm);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmtUtc = dt => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
  const url = `${(process.env.APP_URL || '').replace(/\/$/, '')}/tasks/${task.id}`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PulsAura//CRM//RU', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:task-${task.id}@pulsaura`,
    `DTSTAMP:${fmtUtc(new Date())}`,
    task.due_time ? `DTSTART:${fmtUtc(start)}` : `DTSTART;VALUE=DATE:${task.due_date.replace(/-/g, '')}`,
    task.due_time ? `DTEND:${fmtUtc(end)}` : `DTEND;VALUE=DATE:${task.due_date.replace(/-/g, '')}`,
    `SUMMARY:${esc(task.title)}`,
    `DESCRIPTION:${esc([task.meeting_url ? 'Ссылка: ' + task.meeting_url : '', task.description, url].filter(Boolean).join('\n'))}`,
    task.meeting_url ? `LOCATION:${esc(task.meeting_url)}` : '',
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'DESCRIPTION:Созвон через 10 минут', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="meeting-${task.id}.ics"`);
  res.send(ics);
});

router.post('/tasks/:id/assignees', (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const userId = Number(req.body.user_id);
  const user = userId ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId) : null;
  if (!user) return res.status(400).json({ error: 'user_id_required' });
  if (!perms.canAssign(space.id, userId)) return res.status(403).json({ error: 'personal_space' });

  const info = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(task.id, userId);
  if (info.changes) {
    taskService.logTaskEvent(task.id, req.user.id, 'assignee', `Исполнитель: ${user.name}`);
    if (userId !== req.user.id) telegram.notifyAssigned(userId, task, space.name, req.user.name);
  }
  res.json({ ok: true });
});

router.delete('/tasks/:id/assignees/:userId', (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.params.userId);
  const info = db.prepare('DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?').run(task.id, req.params.userId);
  if (info.changes && user) taskService.logTaskEvent(task.id, req.user.id, 'assignee', `Снят исполнитель: ${user.name}`);
  res.json({ ok: true });
});

// ---------- Move (drag & drop / status select) ----------
// Body: { section_id, before_id?, after_id? }  — neighbour ids as seen on
// the board. Legacy { position } (index) is still accepted.

router.post('/tasks/:id/move', (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!myRole || myRole === 'guest') return res.status(403).json({ error: 'forbidden' });

  const sectionId = Number(req.body.section_id);
  let beforeId = req.body.before_id ? Number(req.body.before_id) : null;
  const afterId = req.body.after_id ? Number(req.body.after_id) : null;

  if (!beforeId && !afterId && Number.isInteger(req.body.position)) {
    const ids = db.prepare('SELECT id FROM tasks WHERE section_id = ? AND id != ? ORDER BY position, id').all(sectionId, task.id).map(r => r.id);
    beforeId = ids[req.body.position] || null;
  }

  try {
    const updated = taskService.moveTask({ task, sectionId, beforeId, afterId, userId: req.user.id });
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'move_failed' });
  }
});

router.delete('/tasks/:id', (req, res) => {
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id) && task.created_by !== req.user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  trash.trashTask(task.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Comments ----------

router.post('/tasks/:id/comments', (req, res) => {
  const wantsJson = req.is('application/json');
  const { task, space } = loadTaskContext(req.params.id);
  if (!task) return wantsJson ? res.status(404).json({ error: 'not_found' }) : res.status(404).send('Задача не найдена');
  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!perms.canSeeTask(req.user, task, space, myRole)) return wantsJson ? res.status(403).json({ error: 'forbidden' }) : res.status(403).send('Нет доступа');

  const body = (req.body.body || '').trim();
  if (!body) return wantsJson ? res.status(400).json({ error: 'body_required' }) : res.redirect(`/tasks/${task.id}`);

  const info = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.id, req.user.id, body);

  const assignees = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id);
  const notifyTargets = new Set(assignees.map(a => a.user_id));
  if (task.created_by) notifyTargets.add(task.created_by);
  notifyTargets.delete(req.user.id);
  notifyTargets.forEach(uid => telegram.notifyComment(task, space.name, body, req.user.name, uid));

  if (!wantsJson) return res.redirect(`/tasks/${task.id}`);
  const comment = db.prepare('SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(info.lastInsertRowid);
  res.status(201).json({ comment: { ...comment, when: req.app.locals.fmt.fmtTimestamp(comment.created_at) } });
});

// ---------- Bulk actions (select many cards on a board / list) ----------
// Body: { ids: [..], action: 'move'|'assign'|'unassign_all'|'due'|'done', section_id?, user_id?, due_date? }
// Only cards the person may manage are touched; the rest are reported as skipped.
router.post('/tasks/bulk', (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 1000);
  const action = String(req.body.action || '');
  let done = 0;
  let skipped = 0;
  for (const id of ids) {
    const { task, space } = loadTaskContext(id);
    if (!task || !perms.canManageSpace(req.user, space.id)) { skipped++; continue; }
    try {
      if (action === 'move') {
        if (task.section_id === Number(req.body.section_id)) { done++; continue; }
        taskService.moveTask({ task, sectionId: Number(req.body.section_id), userId: req.user.id });
      } else if (action === 'assign') {
        const uid = Number(req.body.user_id);
        if (!perms.canAssign(space.id, uid)) { skipped++; continue; }
        const added = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(task.id, uid).changes;
        if (added) {
          const u = db.prepare('SELECT name FROM users WHERE id = ?').get(uid);
          taskService.logTaskEvent(task.id, req.user.id, 'assignee', `Исполнитель: ${u ? u.name : '?'}`);
          if (uid !== req.user.id) telegram.notifyAssigned(uid, task, space.name, req.user.name);
        }
      } else if (action === 'unassign_all') {
        db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(task.id);
        taskService.logTaskEvent(task.id, req.user.id, 'assignee', 'Исполнители сняты');
      } else if (action === 'due') {
        const d = req.body.due_date && dates.isValidDate(req.body.due_date) ? req.body.due_date : null;
        db.prepare(`UPDATE tasks SET due_date = ?${d ? '' : ', due_time = NULL'}, due_notified = 0, reminded_60 = 0, reminded_10 = 0, updated_at = datetime('now') WHERE id = ?`).run(d, task.id);
        taskService.logTaskEvent(task.id, req.user.id, 'due', d ? `Срок: ${dates.dueInfo(d, null).full}` : 'Срок убран');
      } else if (action === 'lead_type') {
        if (!task.client_id) { skipped++; continue; }
        const type = parseLeadType(req.body.lead_type);
        db.prepare('UPDATE clients SET lead_type = ? WHERE id = ?').run(type, task.client_id);
        taskService.logTaskEvent(task.id, req.user.id, 'client', `Тип: ${LEAD_TYPES[type] || 'не указан'}`);
      } else if (action === 'done') {
        taskService.setTaskDone(task, true, req.user.id);
      } else {
        return res.status(400).json({ error: 'unknown_action' });
      }
      if (task.client_id) db.prepare("UPDATE clients SET last_activity_at = datetime('now') WHERE id = ?").run(task.client_id);
      done++;
    } catch (err) {
      skipped++;
    }
  }
  res.json({ ok: true, done, skipped });
});

// ---------- Subtasks ----------

router.post('/tasks/:id/subtasks', async (req, res) => {
  const ctx = requireVisibleTask(req, res, req.params.id);
  if (!ctx) return;
  const { task, space } = ctx;

  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });

  const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;
  if (assigneeId && !perms.canAssign(space.id, assigneeId)) return res.status(403).json({ error: 'personal_space' });
  const dueDate = dates.isValidDate(req.body.due_date) ? req.body.due_date : null;
  const dueTime = dueDate && dates.isValidTime(req.body.due_time) ? req.body.due_time : null;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM subtasks WHERE task_id = ?').get(task.id).m;
  const info = db.prepare('INSERT INTO subtasks (task_id, title, assignee_id, due_date, due_time, position, done) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(task.id, title, assigneeId, dueDate, dueTime, maxPos + 1);

  if (assigneeId && assigneeId !== req.user.id) telegram.notifyAssigned(assigneeId, { ...task, title: `${title} (${task.title})` }, space.name, req.user.name);

  const subtask = loadSubtask(info.lastInsertRowid);
  const users = res.locals.allUsers;
  res.status(201).json({
    subtask,
    counts: taskService.subtaskCounts(task.id),
    html: await renderToString(req, 'partials/task/subtask-row', { s: subtask, users, canManage: ctx.canManage }),
  });
});

router.patch('/subtasks/:id', (req, res) => {
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!subtask) return res.status(404).json({ error: 'not_found' });
  const ctx = requireVisibleTask(req, res, subtask.task_id);
  if (!ctx) return;
  const { task, space } = ctx;

  if ('title' in req.body) {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title_required' });
    db.prepare('UPDATE subtasks SET title = ? WHERE id = ?').run(title, subtask.id);
  }
  // assignee_ids: replace the list; assignee_id (older clients): exactly one person or nobody.
  if ('assignee_ids' in req.body || 'assignee_id' in req.body) {
    const ids = 'assignee_ids' in req.body
      ? (Array.isArray(req.body.assignee_ids) ? req.body.assignee_ids.map(Number).filter(Boolean) : [])
      : (req.body.assignee_id ? [Number(req.body.assignee_id)] : []);
    if (ids.some(uid => !perms.canAssign(space.id, uid))) return res.status(403).json({ error: 'personal_space' });
    const added = taskService.setSubtaskAssignees(subtask.id, ids);
    added.filter(uid => uid !== req.user.id)
      .forEach(uid => telegram.notifyAssigned(uid, { ...task, title: `${subtask.title} (${task.title})` }, space.name, req.user.name));
  }
  if ('due_date' in req.body) {
    const d = dates.isValidDate(req.body.due_date) ? req.body.due_date : null;
    db.prepare(`UPDATE subtasks SET due_date = ?, reminded_60 = 0${d ? '' : ', due_time = NULL'} WHERE id = ?`).run(d, subtask.id);
  }
  if ('due_time' in req.body) {
    db.prepare('UPDATE subtasks SET due_time = ?, reminded_60 = 0 WHERE id = ?').run(dates.isValidTime(req.body.due_time) ? req.body.due_time : null, subtask.id);
  }
  if ('done' in req.body) taskService.setSubtaskDone(subtask, task, Boolean(Number(req.body.done)), req.user.id);

  res.json({ ok: true, subtask: loadSubtask(subtask.id), counts: taskService.subtaskCounts(task.id) });
});

// Add / remove one subtask assignee (quick picker ticks, like task assignees).
router.post('/subtasks/:id/assignees', (req, res) => {
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!subtask) return res.status(404).json({ error: 'not_found' });
  const ctx = requireVisibleTask(req, res, subtask.task_id);
  if (!ctx) return;
  const userId = Number(req.body.user_id);
  if (!userId || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return res.status(400).json({ error: 'user_id_required' });
  if (!perms.canAssign(ctx.space.id, userId)) return res.status(403).json({ error: 'personal_space' });
  if (taskService.addSubtaskAssignee(subtask.id, userId) && userId !== req.user.id) {
    telegram.notifyAssigned(userId, { ...ctx.task, title: `${subtask.title} (${ctx.task.title})` }, ctx.space.name, req.user.name);
  }
  res.json({ ok: true, subtask: loadSubtask(subtask.id) });
});

router.delete('/subtasks/:id/assignees/:userId', (req, res) => {
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!subtask) return res.status(404).json({ error: 'not_found' });
  const ctx = requireVisibleTask(req, res, subtask.task_id);
  if (!ctx) return;
  taskService.removeSubtaskAssignee(subtask.id, Number(req.params.userId));
  res.json({ ok: true, subtask: loadSubtask(subtask.id) });
});

// Drag a subtask from a card into another column → new card with just that subtask.
router.post('/subtasks/:id/split', async (req, res) => {
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!subtask) return res.status(404).json({ error: 'not_found' });
  const { task, space } = loadTaskContext(subtask.task_id);
  const myRole = perms.getSpaceRole(req.user, space.id);
  if (!myRole || myRole === 'guest') return res.status(403).json({ error: 'forbidden' });
  try {
    const created = taskService.splitSubtask({
      subtask, task, space,
      sectionId: Number(req.body.section_id),
      beforeId: req.body.before_id ? Number(req.body.before_id) : null,
      afterId: req.body.after_id ? Number(req.body.after_id) : null,
      userId: req.user.id,
    });
    res.status(201).json({
      task: created,
      html: await renderCard(req, created.id, space),
      parentHtml: await renderCard(req, task.id, space),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'split_failed' });
  }
});

router.delete('/subtasks/:id', (req, res) => {
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!subtask) return res.status(404).json({ error: 'not_found' });
  const { space } = loadTaskContext(subtask.task_id);
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  trash.trashSubtask(subtask.id, req.user.id);
  res.json({ ok: true, counts: taskService.subtaskCounts(subtask.task_id) });
});

module.exports = router;
