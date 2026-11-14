// Recurring tasks: next dates and the copy created on completion.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-rep-')), 't.db');
const db = require('../db');
const { nextDate } = require('../lib/recurrence');
const taskService = require('../lib/task-service');

test('next dates for every rule', () => {
  const today = '2026-09-27'; // Sunday
  assert.strictEqual(nextDate('daily', '2026-09-27', today), '2026-09-28');
  assert.strictEqual(nextDate('every2days', '2026-09-27', today), '2026-09-29');
  assert.strictEqual(nextDate('weekly', '2026-09-27', today), '2026-10-04');
  assert.strictEqual(nextDate('weekdays', '2026-09-25', today), '2026-09-28', 'Fri → Mon, and never in the past');
  assert.strictEqual(nextDate('monthly', '2026-01-31', '2026-01-31'), '2026-02-28', 'end of month clamps');
  assert.strictEqual(nextDate('daily', '2026-09-20', today), '2026-09-28', 'overdue: jumps past today');
  assert.strictEqual(nextDate('daily', null, today), '2026-09-28', 'no date: from today');
});

test('completing a recurring task creates the next one — once', () => {
  const uid = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Даня', 'd@x', 'x')").run().lastInsertRowid;
  const sp = db.prepare("INSERT INTO spaces (name) VALUES ('Life')").run().lastInsertRowid;
  const sec = db.prepare("INSERT INTO sections (space_id, name) VALUES (?, 'Дела')").run(sp).lastInsertRowid;
  const d = new Date(); const pad = n => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const id = db.prepare("INSERT INTO tasks (space_id, section_id, title, due_date, due_time, repeat_rule) VALUES (?, ?, 'Зарядка', ?, '08:00', 'daily')")
    .run(sp, sec, today).lastInsertRowid;
  db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, uid);
  const sid = db.prepare("INSERT INTO subtasks (task_id, title, done, due_date) VALUES (?, 'Растяжка', 1, ?)").run(id, today).lastInsertRowid;
  taskService.setSubtaskAssignees(sid, [uid]);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const nextId = taskService.setTaskDone(task, true, uid);
  assert.ok(nextId);
  const next = db.prepare('SELECT * FROM tasks WHERE id = ?').get(nextId);
  assert.strictEqual(next.done, 0);
  assert.strictEqual(next.repeat_rule, 'daily');
  assert.strictEqual(next.due_time, '08:00');
  assert.ok(next.due_date > today);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM task_assignees WHERE task_id = ?').get(nextId).c, 1);
  const sub = db.prepare('SELECT * FROM subtasks WHERE task_id = ?').get(nextId);
  assert.strictEqual(sub.done, 0, 'subtasks start over');
  assert.strictEqual(sub.due_date, next.due_date, 'subtask date moves with the task');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM subtask_assignees WHERE subtask_id = ?').get(sub.id).c, 1);

  // reopen + complete again → no second copy
  const done = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  taskService.setTaskDone(done, false, uid);
  taskService.setTaskDone(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), true, uid);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'Зарядка'").get().c, 2);
});
