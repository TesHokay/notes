// Trash for deleted tasks and subtasks. A deleted item is snapshotted (task row + assignees,
// subtasks, comments, history) into `trash`, then removed from the live tables — so no other
// query in the app has to know about deleted rows. Restore re-inserts the snapshot with the
// original ids (SQLite AUTOINCREMENT never reuses them). Items older than KEEP_DAYS are purged.
const db = require('../db');
const { transaction, logTaskEvent } = require('./task-service');
const perms = require('./permissions');

const KEEP_DAYS = 30;

db.exec(`
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('task','subtask')),
  item_id INTEGER NOT NULL,
  space_id INTEGER,
  space_name TEXT NOT NULL DEFAULT '',
  section_name TEXT NOT NULL DEFAULT '',
  parent_task_id INTEGER,
  parent_title TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash(deleted_at);
`);
// Personal workspace of the item (kept even if its space is deleted later), NULL = PulsAura.
if (!db.prepare('PRAGMA table_info(trash)').all().some(c => c.name === 'workspace_id')) db.exec('ALTER TABLE trash ADD COLUMN workspace_id INTEGER');

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const exists = (table, id) => id != null && Boolean(one(`SELECT 1 FROM ${table} WHERE id = ?`, id));

function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

// INSERT a snapshot row, keeping only columns the table still has.
function insertRow(table, row) {
  const cols = columnsOf(table).filter(c => c in row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => row[c]));
}

function trashTask(taskId, userId) {
  const task = one('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) return null;
  const space = one('SELECT name, workspace_id FROM spaces WHERE id = ?', task.space_id);
  const section = one('SELECT name FROM sections WHERE id = ?', task.section_id);
  const payload = {
    task,
    assignees: all('SELECT user_id FROM task_assignees WHERE task_id = ?', taskId).map(r => r.user_id),
    subtasks: all('SELECT * FROM subtasks WHERE task_id = ?', taskId),
    subtaskAssignees: all('SELECT sa.subtask_id, sa.user_id FROM subtask_assignees sa JOIN subtasks s ON s.id = sa.subtask_id WHERE s.task_id = ?', taskId),
    comments: all('SELECT * FROM comments WHERE task_id = ?', taskId),
    events: all('SELECT * FROM task_events WHERE task_id = ?', taskId),
  };
  return transaction(() => {
    const id = db.prepare(`
      INSERT INTO trash (kind, item_id, space_id, space_name, section_name, title, payload, deleted_by, workspace_id)
      VALUES ('task', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.space_id, space ? space.name : '', section ? section.name : '', task.title, JSON.stringify(payload), userId, space ? space.workspace_id : null).lastInsertRowid;
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    return id;
  });
}

// Old trash rows have no list — the insert trigger already restored the first assignee.
function restoreSubtaskAssignees(rows) {
  (rows || []).filter(r => exists('users', r.user_id) && exists('subtasks', r.subtask_id))
    .forEach(r => db.prepare('INSERT OR IGNORE INTO subtask_assignees (subtask_id, user_id) VALUES (?, ?)').run(r.subtask_id, r.user_id));
}

function trashSubtask(subtaskId, userId) {
  const s = one('SELECT * FROM subtasks WHERE id = ?', subtaskId);
  if (!s) return null;
  const task = one('SELECT id, title, space_id FROM tasks WHERE id = ?', s.task_id);
  const space = task ? one('SELECT name, workspace_id FROM spaces WHERE id = ?', task.space_id) : null;
  return transaction(() => {
    const id = db.prepare(`
      INSERT INTO trash (kind, item_id, space_id, space_name, parent_task_id, parent_title, title, payload, deleted_by, workspace_id)
      VALUES ('subtask', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, task ? task.space_id : null, space ? space.name : '', s.task_id, task ? task.title : '', s.title, JSON.stringify({ subtask: s, subtaskAssignees: all('SELECT subtask_id, user_id FROM subtask_assignees WHERE subtask_id = ?', s.id) }),
      userId, space ? space.workspace_id : null).lastInsertRowid;
    db.prepare('DELETE FROM subtasks WHERE id = ?').run(s.id);
    if (task) logTaskEvent(task.id, userId, 'subtask_deleted', `Подзадача в корзине: ${s.title}`);
    return id;
  });
}

// Owners see everything; others see what they deleted themselves in spaces they can still open.
function listFor(user) {
  const rows = all(`
    SELECT t.id, t.kind, t.item_id, t.space_id, t.workspace_id, t.space_name, t.section_name, t.parent_task_id, t.parent_title,
      t.title, t.deleted_by, t.deleted_at, u.name AS deleted_by_name
    FROM trash t LEFT JOIN users u ON u.id = t.deleted_by ORDER BY t.deleted_at DESC, t.id DESC
  `);
  return rows.filter(r => canRestore(user, r)).map(r => ({ ...r, can_purge: canPurge(user, r) }));
}

// Personal workspace items: its owner sees all, members what they deleted themselves.
// Team items: PulsAura owners see all, others what they deleted in spaces they can still open.
function canRestore(user, row) {
  if (!row) return false;
  const wsId = row.workspace_id || (row.space_id && perms.workspaceOfSpace(row.space_id) ? perms.workspaceOfSpace(row.space_id).wsId : null);
  if (wsId) {
    const role = perms.workspaceRole(user, wsId);
    return role === 'owner' || (role === 'member' && row.deleted_by === user.id);
  }
  if (user.is_external) return false;
  return Boolean(user.is_owner || (row.deleted_by === user.id && row.space_id && perms.canOpenSpace(user, row.space_id)));
}

// Deleting forever: the personal workspace owner, or a PulsAura owner for team items.
function canPurge(user, row) {
  if (!canRestore(user, row)) return false;
  const wsId = row.workspace_id || (row.space_id && perms.workspaceOfSpace(row.space_id) ? perms.workspaceOfSpace(row.space_id).wsId : null);
  return wsId ? perms.workspaceRole(user, wsId) === 'owner' : Boolean(user.is_owner);
}

// Returns { ok, taskId } or { error } — 'space_gone' | 'parent_gone' | 'already_exists'.
function restore(trashId, user) {
  const row = one('SELECT * FROM trash WHERE id = ?', trashId);
  if (!row) return { error: 'not_found' };
  const data = JSON.parse(row.payload);

  if (row.kind === 'subtask') {
    const s = { ...data.subtask };
    if (!exists('tasks', s.task_id)) return { error: 'parent_gone' };
    if (exists('subtasks', s.id)) return { error: 'already_exists' };
    if (!exists('users', s.assignee_id)) s.assignee_id = null;
    s.position = one('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM subtasks WHERE task_id = ?', s.task_id).m;
    transaction(() => {
      insertRow('subtasks', s);
      restoreSubtaskAssignees(data.subtaskAssignees);
      logTaskEvent(s.task_id, user.id, 'restored', `Подзадача восстановлена из корзины: ${s.title}`);
      db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
    });
    return { ok: true, taskId: s.task_id };
  }

  const t = { ...data.task };
  if (!exists('spaces', t.space_id)) return { error: 'space_gone' };
  if (exists('tasks', t.id)) return { error: 'already_exists' };
  const section = one('SELECT id FROM sections WHERE id = ? AND space_id = ?', t.section_id, t.space_id)
    || one('SELECT id FROM sections WHERE space_id = ? ORDER BY position LIMIT 1', t.space_id);
  if (!section) return { error: 'space_gone' };
  t.section_id = section.id;
  t.position = one('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM tasks WHERE section_id = ?', section.id).m;
  if (!exists('projects', t.project_id)) t.project_id = null;
  if (!exists('clients', t.client_id)) t.client_id = null;
  if (!exists('users', t.created_by)) t.created_by = null;
  if (!exists('tasks', t.split_from_task_id)) t.split_from_task_id = null;

  transaction(() => {
    insertRow('tasks', t);
    data.assignees.filter(uid => exists('users', uid))
      .forEach(uid => db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(t.id, uid));
    data.subtasks.forEach(s => {
      if (exists('subtasks', s.id)) return;
      insertRow('subtasks', { ...s, assignee_id: exists('users', s.assignee_id) ? s.assignee_id : null });
    });
    restoreSubtaskAssignees(data.subtaskAssignees);
    data.comments.filter(c => exists('users', c.user_id) && !exists('comments', c.id)).forEach(c => insertRow('comments', c));
    data.events.filter(e => !exists('task_events', e.id))
      .forEach(e => insertRow('task_events', { ...e, user_id: exists('users', e.user_id) ? e.user_id : null }));
    logTaskEvent(t.id, user.id, 'restored', 'Восстановлена из корзины');
    db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
  });
  return { ok: true, taskId: t.id };
}

function purge(trashId) {
  db.prepare('DELETE FROM trash WHERE id = ?').run(trashId);
}

function purgeExpired() {
  return db.prepare(`DELETE FROM trash WHERE deleted_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`).changes;
}

module.exports = { KEEP_DAYS, trashTask, trashSubtask, listFor, canRestore, canPurge, restore, purge, purgeExpired };
