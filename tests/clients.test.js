// Clients overview: stage, next action, "quiet" detection.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-clients-')), 't.db');
const db = require('../db');
const dates = require('../lib/dates');
const { clientOverview } = require('../lib/client-overview');

const uid = db.prepare("INSERT INTO users (name, email, password_hash, is_owner) VALUES ('Даня', 'd@x', 'x', 1)").run().lastInsertRowid;
const sp = db.prepare("INSERT INTO spaces (name, card_mode) VALUES ('Sales', 'client')").run().lastInsertRowid;
const sec = n => db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)').run(sp, n, db.prepare('SELECT COUNT(*) c FROM sections').get().c).lastInsertRowid;
const lead = sec('Новый лид'); const offer = sec('КП / Оффер'); const lost = sec('Неактуально');

function client(name, { section = lead, daysAgo = 0, sub } = {}) {
  const ts = `datetime('now', '-${daysAgo} days')`;
  const cid = db.prepare(`INSERT INTO clients (name, last_activity_at, created_at) VALUES (?, ${ts}, ${ts})`).run(name).lastInsertRowid;
  const tid = db.prepare(`INSERT INTO tasks (space_id, section_id, client_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ${ts}, ${ts})`).run(sp, section, cid, name).lastInsertRowid;
  db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(tid, uid);
  if (sub) db.prepare('INSERT INTO subtasks (task_id, title, due_date, assignee_id) VALUES (?, ?, ?, ?)').run(tid, sub.title, sub.due, uid);
  return cid;
}
const byName = name => clientOverview(null).find(r => r.client.name === name);

test('quiet: open deal, 14+ days without movement, nothing planned', () => {
  client('Биокад', { daysAgo: 20 });
  const r = byName('Биокад');
  assert.strictEqual(r.quiet, true);
  assert.strictEqual(r.stage.name, 'Новый лид');
  assert.ok(r.idleDays >= 20);
  assert.strictEqual(r.people[0].name, 'Даня');
});

test('not quiet: recent movement, a planned next step, or a closed stage', () => {
  client('Талисман', { daysAgo: 2 });
  client('Планета', { daysAgo: 30, section: offer, sub: { title: 'доделать док', due: dates.addDays(dates.localDate(), 2) } });
  client('Старый', { daysAgo: 60, section: lost });
  assert.strictEqual(byName('Талисман').quiet, false);
  const planeta = byName('Планета');
  assert.strictEqual(planeta.quiet, false);
  assert.strictEqual(planeta.next.title, 'доделать док');
  assert.strictEqual(planeta.stage.name, 'КП / Оффер');
  assert.strictEqual(byName('Старый').quiet, false);
  assert.strictEqual(byName('Старый').activeDeal, false);
});

test('team overview: a card is "unassigned" only if nobody is on it or its open subtasks', () => {
  const ov = require('../lib/team-overview');
  const bare = db.prepare("INSERT INTO tasks (space_id, section_id, title) VALUES (?, ?, 'Пустая')").run(sp, lead).lastInsertRowid;
  const staffed = db.prepare("INSERT INTO tasks (space_id, section_id, title) VALUES (?, ?, 'Через подзадачи')").run(sp, lead).lastInsertRowid;
  db.prepare("INSERT INTO subtasks (task_id, title, assignee_id) VALUES (?, 'шаг', ?)").run(staffed, uid);
  const ids = ov.loadTeamItems().filter(ov.isUnassigned).map(i => i.id);
  assert.ok(ids.includes(bare));
  assert.ok(!ids.includes(staffed));
});

test('a client without deals is listed but not active', () => {
  db.prepare("INSERT INTO clients (name) VALUES ('Без сделки')").run();
  const r = byName('Без сделки');
  assert.strictEqual(r.activeDeal, false);
  assert.strictEqual(r.stage, null);
  assert.strictEqual(r.openCount, 0);
});
