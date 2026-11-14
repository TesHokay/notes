// Intake from the cold outreach bot: warm leads become cards in «Холодные касания», moved by stage.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-outreach-')), 't.db');
process.env.TZ = 'Europe/Moscow';
const db = require('../db');
const outreach = require('../lib/outreach');

const vanya = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Ваня', 'v@x', 'x')").run().lastInsertRowid;
const card = id => db.prepare('SELECT t.*, s.name AS stage FROM tasks t JOIN sections s ON s.id = t.section_id WHERE t.id = ?').get(id);
const base = { company_id: 'c-1', company: { name: 'ООО Ромашка', website: 'romashka.ru' }, contact: { email: 'boss@romashka.ru' }, owner: 'vanya' };

test('first reply creates client + card in «Ответили», assigned to the owner', () => {
  const r = outreach.handleEvent({ ...base, event_id: 'e1', event: 'replied', reply_text: 'Интересно, пришлите КП' });
  assert.strictEqual(r.stage, 'Ответили');
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(r.client_id);
  assert.strictEqual(c.outreach_id, 'c-1');
  assert.strictEqual(c.contact_email, 'boss@romashka.ru');
  assert.ok(db.prepare('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?').get(r.task_id, vanya));
  assert.ok(db.prepare("SELECT 1 FROM client_events WHERE client_id = ? AND body LIKE '%пришлите КП%'").get(r.client_id));
});

test('same event twice → no second deal', () => {
  const r = outreach.handleEvent({ ...base, event_id: 'e1', event: 'replied' });
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
});

test('call booked, moved, held: one call subtask, card follows the stages', () => {
  const r = outreach.handleEvent({ ...base, event_id: 'e2', event: 'call_scheduled', call_at: '2026-10-30T12:00:00Z' });
  assert.strictEqual(card(r.task_id).stage, 'Созвон назначен');
  let subs = db.prepare('SELECT * FROM subtasks WHERE task_id = ?').all(r.task_id);
  assert.strictEqual(subs.length, 1);
  assert.deepStrictEqual([subs[0].due_date, subs[0].due_time], ['2026-10-30', '15:00'], 'UTC → Moscow');
  outreach.handleEvent({ ...base, event_id: 'e3', event: 'call_rescheduled', call_at: '2026-10-31T16:30:00+03:00' });
  subs = db.prepare('SELECT * FROM subtasks WHERE task_id = ?').all(r.task_id);
  assert.strictEqual(subs.length, 1, 'moved, not duplicated');
  assert.strictEqual(subs[0].due_time, '16:30');
  outreach.handleEvent({ ...base, event_id: 'e4', event: 'call_done' });
  assert.strictEqual(card(r.task_id).stage, 'Созвон прошёл');
  assert.strictEqual(db.prepare('SELECT done FROM subtasks WHERE task_id = ?').get(r.task_id).done, 1);
  const late = outreach.handleEvent({ ...base, event_id: 'e5', event: 'replied' });
  assert.strictEqual(card(late.task_id).stage, 'Созвон прошёл', 'a late «replied» does not pull the card back');
});

test('refusal → «Отказ / не беспокоить»; bad input is rejected', () => {
  const r = outreach.handleEvent({ ...base, company_id: 'c-2', company: { name: 'ИП Лютик' }, event_id: 'e6', event: 'do_not_contact' });
  assert.strictEqual(card(r.task_id).stage, 'Отказ / не беспокоить');
  assert.throws(() => outreach.handleEvent({ ...base, event: 'nope' }), outreach.InputError);
  assert.throws(() => outreach.handleEvent({ ...base, event: 'call_scheduled', event_id: 'x' }), /call_at/);
  assert.throws(() => outreach.handleEvent({ event: 'replied', company: { name: 'X' } }), /company_id/);
});

test('unknown owner → accepted, with a warning', () => {
  const r = outreach.handleEvent({ ...base, company_id: 'c-3', company: { name: 'Третьи' }, event_id: 'e7', event: 'replied', owner: 'Петя' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
});
