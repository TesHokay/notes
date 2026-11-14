// Trash: deleted tasks/subtasks can be restored with everything attached.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-trash-')), 't.db');
const db = require('../db');
const trash = require('../lib/trash');

const owner = { id: db.prepare("INSERT INTO users (name, email, password_hash, is_owner) VALUES ('Даня', 'o@x', 'x', 1)").run().lastInsertRowid, is_owner: 1 };
const member = { id: db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Ник', 'm@x', 'x')").run().lastInsertRowid, is_owner: 0 };
const sp = db.prepare("INSERT INTO spaces (name) VALUES ('Production')").run().lastInsertRowid;
const secA = db.prepare("INSERT INTO sections (space_id, name, position) VALUES (?, 'A', 0)").run(sp).lastInsertRowid;
const secB = db.prepare("INSERT INTO sections (space_id, name, position) VALUES (?, 'B', 1)").run(sp).lastInsertRowid;
db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')").run(sp, member.id);

function makeTask(section = secB) {
  const id = db.prepare("INSERT INTO tasks (space_id, section_id, title, due_date) VALUES (?, ?, 'Ролик', '2026-10-01')").run(sp, section).lastInsertRowid;
  db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, member.id);
  db.prepare("INSERT INTO subtasks (task_id, title, assignee_id) VALUES (?, 'Монтаж', ?)").run(id, member.id);
  db.prepare("INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, 'ок')").run(id, owner.id);
  return id;
}
const count = (sql, ...p) => db.prepare(sql).get(...p).c;

test('deleted task goes to trash and comes back with subtasks, comments, assignees', () => {
  const id = makeTask();
  trash.trashTask(id, member.id);
  assert.strictEqual(count('SELECT COUNT(*) c FROM tasks WHERE id = ?', id), 0);
  const row = trash.listFor(owner).find(r => r.item_id === id);
  assert.ok(row);
  assert.strictEqual(row.section_name, 'B');

  const res = trash.restore(row.id, owner);
  assert.deepStrictEqual(res, { ok: true, taskId: id });
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.strictEqual(t.section_id, secB);
  assert.strictEqual(t.due_date, '2026-10-01');
  assert.strictEqual(count('SELECT COUNT(*) c FROM subtasks WHERE task_id = ?', id), 1);
  assert.strictEqual(count('SELECT COUNT(*) c FROM comments WHERE task_id = ?', id), 1);
  assert.strictEqual(count('SELECT COUNT(*) c FROM task_assignees WHERE task_id = ?', id), 1);
  assert.strictEqual(trash.listFor(owner).length, 0, 'trash row removed');
});

test('subtask with several assignees keeps all of them through trash', () => {
  const id = makeTask();
  const sid = db.prepare('SELECT id FROM subtasks WHERE task_id = ?').get(id).id;
  require('../lib/task-service').setSubtaskAssignees(sid, [member.id, owner.id]);
  trash.trashTask(id, owner.id);
  trash.restore(trash.listFor(owner).find(r => r.item_id === id).id, owner);
  assert.strictEqual(count('SELECT COUNT(*) c FROM subtask_assignees WHERE subtask_id = ?', sid), 2);
});

test('restores into the first column when the original column is gone', () => {
  const secC = db.prepare("INSERT INTO sections (space_id, name, position) VALUES (?, 'C', 2)").run(sp).lastInsertRowid;
  const id = makeTask(secC);
  trash.trashTask(id, owner.id);
  db.prepare('DELETE FROM sections WHERE id = ?').run(secC);
  trash.restore(trash.listFor(owner)[0].id, owner);
  assert.strictEqual(db.prepare('SELECT section_id FROM tasks WHERE id = ?').get(id).section_id, secA);
});

test('subtask restore; blocked while its task is deleted', () => {
  const id = makeTask();
  const sid = db.prepare('SELECT id FROM subtasks WHERE task_id = ?').get(id).id;
  trash.trashSubtask(sid, member.id);
  trash.trashTask(id, member.id);
  const subRow = trash.listFor(owner).find(r => r.kind === 'subtask' && r.item_id === sid);
  assert.deepStrictEqual(trash.restore(subRow.id, owner), { error: 'parent_gone' });
  trash.restore(trash.listFor(owner).find(r => r.kind === 'task' && r.item_id === id).id, owner);
  assert.ok(trash.restore(subRow.id, owner).ok);
  assert.strictEqual(db.prepare('SELECT title FROM subtasks WHERE id = ?').get(sid).title, 'Монтаж');
});

test('non-owners only see what they deleted; old items are purged', () => {
  const a = makeTask(); const b = makeTask();
  trash.trashTask(a, member.id);
  trash.trashTask(b, owner.id);
  assert.deepStrictEqual(trash.listFor({ ...member, is_owner: 0 }).map(r => r.item_id), [a]);
  db.prepare("UPDATE trash SET deleted_at = datetime('now', '-31 days') WHERE item_id = ?").run(a);
  assert.strictEqual(trash.purgeExpired(), 1);
  assert.deepStrictEqual(trash.listFor(owner).map(r => r.item_id), [b]);
});
