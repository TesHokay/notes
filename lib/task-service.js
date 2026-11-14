// Business logic for tasks/subtasks, kept out of routes and templates.
const db = require('../db');

function logTaskEvent(taskId, userId, type, body) {
  db.prepare('INSERT INTO task_events (task_id, user_id, type, body) VALUES (?, ?, ?, ?)')
    .run(taskId, userId || null, type, body || '');
}

function logClientEvent(clientId, userId, type, body) {
  db.prepare('INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, ?, ?)')
    .run(clientId, userId || null, type, body || '');
  db.prepare("UPDATE clients SET last_activity_at = datetime('now') WHERE id = ?").run(clientId);
}

// Nested calls (moveTask inside an outer transaction) just join the outer one.
function transaction(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Move a task to a section and place it relative to its visible neighbours.
 *
 * The client sends the ids of the cards directly before/after the drop slot
 * (as the user SAW them), not a numeric index. The board hides completed
 * tasks, filtered-out tasks and tasks the viewer has no access to, so a
 * visible index does not match the index in the full column — placing by
 * neighbour ids stays correct no matter what is hidden.
 *
 * Positions are re-numbered 0..n-1 for the touched columns inside one
 * transaction (simple integer ordering is enough at this scale).
 */
function placeInSection(taskId, sectionId, beforeId, afterId) {
  const ids = db.prepare('SELECT id FROM tasks WHERE section_id = ? AND id != ? ORDER BY position ASC, id ASC')
    .all(sectionId, taskId).map(r => r.id);
  let insertAt = ids.length;
  const beforeIdx = beforeId ? ids.indexOf(Number(beforeId)) : -1;
  const afterIdx = afterId ? ids.indexOf(Number(afterId)) : -1;
  if (beforeIdx !== -1) insertAt = beforeIdx;          // card that ends up right below
  else if (afterIdx !== -1) insertAt = afterIdx + 1;   // card that ends up right above
  ids.splice(insertAt, 0, taskId);
  const upd = db.prepare('UPDATE tasks SET section_id = ?, position = ? WHERE id = ?');
  ids.forEach((id, i) => upd.run(sectionId, i, id));
}

function renumber(sectionId) {
  const rows = db.prepare('SELECT id FROM tasks WHERE section_id = ? ORDER BY position ASC, id ASC').all(sectionId);
  const upd = db.prepare('UPDATE tasks SET position = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i, r.id));
}

function badRequest(code) {
  const err = new Error(code);
  err.status = 400;
  return err;
}

function moveTask({ task, sectionId, beforeId, afterId, userId }) {
  const section = db.prepare('SELECT * FROM sections WHERE id = ? AND space_id = ?').get(sectionId, task.space_id);
  if (!section) {
    const err = new Error('invalid_section');
    err.status = 400;
    throw err;
  }
  const fromSectionId = task.section_id;

  transaction(() => {
    placeInSection(task.id, section.id, beforeId, afterId);
    if (fromSectionId !== section.id) {
      renumber(fromSectionId);
      db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(task.id);
    }
  });

  if (fromSectionId !== section.id) {
    const from = db.prepare('SELECT name FROM sections WHERE id = ?').get(fromSectionId);
    logTaskEvent(task.id, userId, 'moved', `${from ? from.name : '?'} → ${section.name}`);
    if (task.client_id) logClientEvent(task.client_id, userId, 'stage_change', `Перемещён в «${section.name}»`);
  }

  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
}

/**
 * Split a subtask out into its own card in another column: a copy of the
 * parent card (title, project, client, assignees, priority, due, description)
 * that holds only this subtask. The subtask itself is MOVED (not copied), so
 * its history, assignee and completion state travel with it. Both cards are
 * linked via split_from_task_id.
 */
function splitSubtask({ subtask, task, space, sectionId, beforeId, afterId, userId }) {
  const section = db.prepare('SELECT * FROM sections WHERE id = ? AND space_id = ?').get(sectionId, task.space_id);
  if (!section) throw badRequest('invalid_section');
  if (section.id === task.section_id) throw badRequest('same_section');

  const isDeal = space.card_mode === 'client' && task.client_id;
  const newId = transaction(() => {
    const info = db.prepare(`
      INSERT INTO tasks (space_id, section_id, project_id, client_id, title, description, priority, due_date, due_time, created_by, position, split_from_task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(task.space_id, section.id, task.project_id, task.client_id,
      // Sales: the new card is another deal of the same client, named after the subtask ("Клиент / SEO").
      isDeal ? subtask.title : task.title,
      isDeal ? '' : (task.description || ''), task.priority,
      isDeal ? null : task.due_date, isDeal ? null : task.due_time, userId, task.id);
    const id = info.lastInsertRowid;
    db.prepare('INSERT INTO task_assignees (task_id, user_id) SELECT ?, user_id FROM task_assignees WHERE task_id = ?').run(id, task.id);
    db.prepare('UPDATE subtasks SET task_id = ?, position = 0 WHERE id = ?').run(id, subtask.id);
    placeInSection(id, section.id, beforeId, afterId);
    return id;
  });

  logTaskEvent(newId, userId, 'split', `Создана из подзадачи «${subtask.title}» карточки «${task.title}» → ${section.name}`);
  logTaskEvent(task.id, userId, 'split', `Подзадача «${subtask.title}» вынесена в отдельную карточку → ${section.name}`);
  if (isDeal) logClientEvent(task.client_id, userId, 'deal_created', `Новая сделка «${subtask.title}» → ${section.name}`);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId);
}

function setTaskDone(task, done, userId) {
  const flag = done ? 1 : 0;
  if (flag === task.done) return;
  db.prepare(`UPDATE tasks SET done = ?, completed_at = ${flag ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`)
    .run(flag, task.id);
  logTaskEvent(task.id, userId, flag ? 'completed' : 'reopened', flag ? 'Задача выполнена' : 'Задача возвращена в работу');
  if (task.client_id) logClientEvent(task.client_id, userId, flag ? 'completed' : 'reopened', flag ? `Карточка «${task.title}» закрыта` : `Карточка «${task.title}» снова в работе`);
  // Recurring: completing it creates the next one.
  if (flag && task.repeat_rule) return require('./recurrence').spawnNext(task, userId);
  return null;
}

function setSubtaskDone(subtask, task, done, userId) {
  const flag = done ? 1 : 0;
  if (flag === subtask.done) return;
  db.prepare(`UPDATE subtasks SET done = ?, completed_at = ${flag ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(flag, subtask.id);
  logTaskEvent(task.id, userId, flag ? 'subtask_done' : 'subtask_reopened', `${flag ? 'Выполнено' : 'Снова в работе'}: ${subtask.title}`);
  if (task.client_id) logClientEvent(task.client_id, userId, flag ? 'action_done' : 'action_reopened', `${flag ? 'Выполнено' : 'Снова в работе'}: ${subtask.title}`);
}

function subtaskCounts(taskId) {
  return db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM subtasks WHERE task_id = ?').get(taskId);
}

/**
 * Enrich task rows with everything a board card needs
 * (assignees, subtasks, counts, comment count).
 */
// ---------- Clients by name, per pipeline ----------
// A client with this name that already has a deal in this space, or a "free" client with no deals
// anywhere (e.g. added on the Clients page). Never another salesperson's client from their own
// pipeline — two people working a lead called the same don't get merged into one record.
function findClientForSpace(name, spaceId) {
  return db.prepare(`
    SELECT c.* FROM clients c
    WHERE ru_lower(c.name) = ru_lower(?) AND (
      EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.id AND t.space_id = ?)
      OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.id)
    )
    ORDER BY EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.id AND t.space_id = ?) DESC, c.id
    LIMIT 1
  `).get(name, spaceId, spaceId) || null;
}

// ---------- Subtask assignees (several per subtask) ----------

// Adds s.people = [{id, name}] to each subtask row (mutates and returns the array).
function attachSubtaskPeople(subtasks) {
  if (!subtasks.length) return subtasks;
  const byId = {};
  const ph = subtasks.map(() => '?').join(',');
  db.prepare(`SELECT sa.subtask_id, u.id, u.name FROM subtask_assignees sa JOIN users u ON u.id = sa.user_id WHERE sa.subtask_id IN (${ph}) ORDER BY u.name`)
    .all(...subtasks.map(s => s.id)).forEach(r => (byId[r.subtask_id] ||= []).push({ id: r.id, name: r.name }));
  subtasks.forEach(s => { s.people = byId[s.id] || []; });
  return subtasks;
}

function subtaskAssigneeIds(subtaskId) {
  return db.prepare('SELECT user_id FROM subtask_assignees WHERE subtask_id = ? ORDER BY rowid').all(subtaskId).map(r => r.user_id);
}

// Keeps subtasks.assignee_id = first remaining assignee (older code reads it).
function syncFirstAssignee(subtaskId) {
  const first = db.prepare('SELECT user_id FROM subtask_assignees WHERE subtask_id = ? ORDER BY rowid LIMIT 1').get(subtaskId);
  db.prepare('UPDATE subtasks SET assignee_id = ? WHERE id = ?').run(first ? first.user_id : null, subtaskId);
}

function addSubtaskAssignee(subtaskId, userId) {
  const added = db.prepare('INSERT OR IGNORE INTO subtask_assignees (subtask_id, user_id) VALUES (?, ?)').run(subtaskId, userId).changes > 0;
  syncFirstAssignee(subtaskId);
  return added;
}

function removeSubtaskAssignee(subtaskId, userId) {
  db.prepare('DELETE FROM subtask_assignees WHERE subtask_id = ? AND user_id = ?').run(subtaskId, userId);
  syncFirstAssignee(subtaskId);
}

// Replace the whole list (null/[] clears). Returns ids that were newly added.
function setSubtaskAssignees(subtaskId, userIds) {
  const before = new Set(subtaskAssigneeIds(subtaskId));
  const next = [...new Set((userIds || []).map(Number).filter(Boolean))];
  db.prepare('DELETE FROM subtask_assignees WHERE subtask_id = ?').run(subtaskId);
  next.forEach(uid => db.prepare('INSERT OR IGNORE INTO subtask_assignees (subtask_id, user_id) VALUES (?, ?)').run(subtaskId, uid));
  syncFirstAssignee(subtaskId);
  return next.filter(uid => !before.has(uid));
}

// Whole days since an SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS'); null when unknown.
function daysSince(ts) {
  if (!ts) return null;
  const ms = Date.parse(String(ts).replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function enrichForCards(tasks) {
  const ids = tasks.map(t => t.id);
  const assigneesByTask = {};
  const subtasksByTask = {};
  const commentsByTask = {};
  const movedAtByTask = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id IN (${ph}) ORDER BY u.name`)
      .all(...ids).forEach(r => (assigneesByTask[r.task_id] ||= []).push({ id: r.id, name: r.name }));
    const subs = db.prepare(`SELECT s.* FROM subtasks s WHERE s.task_id IN (${ph}) ORDER BY s.position ASC, s.id ASC`).all(...ids);
    attachSubtaskPeople(subs);
    subs.forEach(r => (subtasksByTask[r.task_id] ||= []).push(r));
    db.prepare(`SELECT task_id, COUNT(*) AS c FROM comments WHERE task_id IN (${ph}) GROUP BY task_id`)
      .all(...ids).forEach(r => { commentsByTask[r.task_id] = r.c; });
    db.prepare(`SELECT task_id, MAX(created_at) AS at FROM task_events WHERE type = 'moved' AND task_id IN (${ph}) GROUP BY task_id`)
      .all(...ids).forEach(r => { movedAtByTask[r.task_id] = r.at; });
  }
  return tasks.map(t => {
    const subtasks = subtasksByTask[t.id] || [];
    return {
      ...t,
      assignees: assigneesByTask[t.id] || [],
      subtasks,
      activeSubtasks: subtasks.filter(s => !s.done),
      subtask_count: subtasks.length,
      subtask_done: subtasks.filter(s => s.done).length,
      comment_count: commentsByTask[t.id] || 0,
      stage_days: daysSince(movedAtByTask[t.id] || t.created_at),
    };
  });
}

const CARD_SELECT = `
  SELECT t.*, p.name AS project_name, c.name AS client_name, c.website AS client_website,
    c.next_touch_at AS client_next_touch_at, c.last_activity_at AS client_last_activity, c.contact_name AS client_contact, c.lead_type AS client_lead_type, sec.name AS section_name
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN clients c ON c.id = t.client_id
  LEFT JOIN sections sec ON sec.id = t.section_id
`;

function loadCardTask(taskId) {
  const t = db.prepare(`${CARD_SELECT} WHERE t.id = ?`).get(taskId);
  return t ? enrichForCards([t])[0] : null;
}

module.exports = {
  logTaskEvent, logClientEvent, transaction, moveTask, splitSubtask, setTaskDone, setSubtaskDone,
  subtaskCounts, enrichForCards, loadCardTask, CARD_SELECT,
  attachSubtaskPeople, subtaskAssigneeIds, addSubtaskAssignee, removeSubtaskAssignee, setSubtaskAssignees,
  findClientForSpace,
};
