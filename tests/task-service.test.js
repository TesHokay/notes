// Unit tests for the task service (move / ordering / completion).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const db = require('../db');
const svc = require('../lib/task-service');

db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('U', 'u@x', 'x')").run();
const space = db.prepare("INSERT INTO spaces (name) VALUES ('S')").run().lastInsertRowid;
const secA = db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 0)').run(space, 'A').lastInsertRowid;
const secB = db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 1)').run(space, 'B').lastInsertRowid;
const other = db.prepare("INSERT INTO spaces (name) VALUES ('Other')").run().lastInsertRowid;
const secOther = db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 0)').run(other, 'X').lastInsertRowid;

function mk(title, section, pos, done = 0) {
  return db.prepare('INSERT INTO tasks (space_id, section_id, title, position, done) VALUES (?, ?, ?, ?, ?)').run(space, section, title, pos, done).lastInsertRowid;
}
const get = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const order = sec => db.prepare('SELECT title FROM tasks WHERE section_id = ? ORDER BY position, id').all(sec).map(r => r.title);

const t1 = mk('T1', secA, 0);
const hidden = mk('HiddenDone', secA, 1, 1);
const t2 = mk('T2', secA, 2);
const t3 = mk('T3', secA, 3);

test('move to another section appends at end and renumbers source', () => {
  svc.moveTask({ task: get(t1), sectionId: secB, userId: 1 });
  assert.deepStrictEqual(order(secB), ['T1']);
  assert.deepStrictEqual(order(secA), ['HiddenDone', 'T2', 'T3']);
  assert.deepStrictEqual(db.prepare('SELECT position FROM tasks WHERE section_id = ? ORDER BY position').all(secA).map(r => r.position), [0, 1, 2]);
});

test('move into an empty section works', () => {
  const secC = db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, 2)').run(space, 'C').lastInsertRowid;
  svc.moveTask({ task: get(t1), sectionId: secC, userId: 1 });
  assert.strictEqual(get(t1).section_id, secC);
  assert.deepStrictEqual(order(secB), []);
});

test('reorder by neighbour ids is correct even with hidden (done) tasks in the column', () => {
  // visible order: T2, T3 (HiddenDone is not shown). Drag T3 above T2.
  svc.moveTask({ task: get(t3), sectionId: secA, beforeId: t2, userId: 1 });
  const visible = order(secA).filter(t => t !== 'HiddenDone');
  assert.deepStrictEqual(visible, ['T3', 'T2']);
});

test('placing after a neighbour (drop at the bottom)', () => {
  svc.moveTask({ task: get(t3), sectionId: secA, afterId: t2, userId: 1 });
  assert.deepStrictEqual(order(secA).filter(t => t !== 'HiddenDone'), ['T2', 'T3']);
});

test('cannot move into a section of another space', () => {
  assert.throws(() => svc.moveTask({ task: get(t2), sectionId: secOther, userId: 1 }), /invalid_section/);
  assert.strictEqual(get(t2).section_id, secA);
});

test('move is logged in activity', () => {
  const ev = db.prepare("SELECT body FROM task_events WHERE task_id = ? AND type = 'moved'").all(t1);
  assert.ok(ev.some(e => e.body === 'A → B'));
});

test('completing a subtask keeps it in DB with completed_at, counts update', () => {
  const sub = db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, 0)').run(t2, 'S1').lastInsertRowid;
  db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, 1)').run(t2, 'S2');
  svc.setSubtaskDone(db.prepare('SELECT * FROM subtasks WHERE id = ?').get(sub), get(t2), true, 1);
  const row = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(sub);
  assert.strictEqual(row.done, 1);
  assert.ok(row.completed_at);
  assert.deepStrictEqual({ ...svc.subtaskCounts(t2) }, { total: 2, done: 1 });
  const card = svc.loadCardTask(t2);
  assert.deepStrictEqual(card.activeSubtasks.map(s => s.title), ['S2']);
});

test('completing a task sets completed_at; reopening clears it', () => {
  svc.setTaskDone(get(t2), true, 1);
  assert.ok(get(t2).completed_at);
  svc.setTaskDone(get(t2), false, 1);
  assert.strictEqual(get(t2).completed_at, null);
});

test('dates: dueInfo states', () => {
  const dates = require('../lib/dates');
  const now = new Date(2026, 8, 23, 15, 0);
  assert.strictEqual(dates.dueInfo('2026-09-22', null, now).state, 'overdue');
  assert.strictEqual(dates.dueInfo('2026-09-23', '14:00', now).state, 'overdue');
  assert.strictEqual(dates.dueInfo('2026-09-23', '18:00', now).state, 'today');
  assert.strictEqual(dates.dueInfo('2026-09-23', '18:00', now).label, 'Сегодня · ср, 18:00');
  assert.strictEqual(dates.dueInfo('2026-09-24', null, now).label, 'Завтра · чт');
  assert.strictEqual(dates.dueInfo('2026-09-25', null, now).label, 'Послезавтра · пт');
  assert.strictEqual(dates.dueInfo('2026-09-27', null, now).label, 'вс, 27 сент.');
  assert.strictEqual(dates.dayTitle('2026-09-24'), 'четверг, 24 сентября');
  assert.strictEqual(dates.dueInfo('2026-09-26', '18:30', now).full, `суббота, 26 сентября 2026, 18:30 ${dates.tzLabel()}`);
  assert.strictEqual(dates.dueInfo('2026-09-26', null, now).full, 'суббота, 26 сентября 2026');
});
