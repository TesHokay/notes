// Telegram reminders for meetings and timed tasks (Telegram API is stubbed).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-rem-')), 't.db');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const sent = [];
global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { json: async () => ({ ok: true }) }; };

const db = require('../db');
const dates = require('../lib/dates');
const telegram = require('../lib/telegram');

const uid = db.prepare("INSERT INTO users (name, email, password_hash, telegram_chat_id) VALUES ('Даня', 'd@x', 'x', '777')").run().lastInsertRowid;
const sp = db.prepare("INSERT INTO spaces (name) VALUES ('P')").run().lastInsertRowid;
const sec = db.prepare("INSERT INTO sections (space_id, name) VALUES (?, 'A')").run(sp).lastInsertRowid;
const pad = n => String(n).padStart(2, '0');

function at(minFromNow, kind, url) {
  const d = new Date(Date.now() + minFromNow * 60000);
  const id = db.prepare('INSERT INTO tasks (space_id, section_id, title, kind, meeting_url, due_date, due_time) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sp, sec, kind === 'meeting' ? 'Созвон с клиентом' : 'Сдать ролик', kind, url || null, dates.localDate(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`).lastInsertRowid;
  db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, uid);
  return id;
}
const flush = () => new Promise(r => setTimeout(r, 20));

test('meeting: 1h reminder, then 10-min reminder with join button, each only once', async () => {
  const id = at(50, 'meeting', 'https://telemost.yandex.ru/j/1');
  telegram.checkReminders(); await flush();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Через (4\d|50) мин созвон/);
  telegram.checkReminders(); await flush();
  assert.strictEqual(sent.length, 1, 'not repeated');
  telegram.checkReminders(new Date(Date.now() + 41 * 60000)); await flush();
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1].text, /мин созвон/);
  assert.strictEqual(sent[1].reply_markup.inline_keyboard[0][0].url, 'https://telemost.yandex.ru/j/1');
  assert.strictEqual(db.prepare('SELECT reminded_10 FROM tasks WHERE id = ?').get(id).reminded_10, 1);
});

test('task with a time: reminder 1h before the deadline, no 10-min one', async () => {
  sent.length = 0;
  at(45, 'task');
  telegram.checkReminders(); await flush();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Через (4[4-5]) мин срок/);
  telegram.checkReminders(new Date(Date.now() + 40 * 60000)); await flush();
  assert.strictEqual(sent.length, 1);
});

test('subtask with a time: reminder 1h before to its assignee, only once', async () => {
  sent.length = 0;
  const parent = db.prepare("INSERT INTO tasks (space_id, section_id, title) VALUES (?, ?, 'Дороу')").run(sp, sec).lastInsertRowid;
  const d = new Date(Date.now() + 55 * 60000);
  db.prepare("INSERT INTO subtasks (task_id, title, assignee_id, due_date, due_time) VALUES (?, 'чек срм', ?, ?, ?)")
    .run(parent, uid, dates.localDate(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  telegram.checkReminders(); await flush();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Через (час|5\d мин) срок: <b>чек срм<\/b> \(Дороу/);
  telegram.checkReminders(); await flush();
  assert.strictEqual(sent.length, 1, 'not repeated');
});

test('subtask with two assignees: both get the reminder', async () => {
  sent.length = 0;
  const other = db.prepare("INSERT INTO users (name, email, password_hash, telegram_chat_id) VALUES ('Стас', 's@x', 'x', '888')").run().lastInsertRowid;
  const parent = db.prepare("INSERT INTO tasks (space_id, section_id, title) VALUES (?, ?, 'Съёмка')").run(sp, sec).lastInsertRowid;
  const d = new Date(Date.now() + 50 * 60000);
  const sid = db.prepare('INSERT INTO subtasks (task_id, title, due_date, due_time) VALUES (?, ?, ?, ?)')
    .run(parent, 'Свет', dates.localDate(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`).lastInsertRowid;
  require('../lib/task-service').setSubtaskAssignees(sid, [uid, other]);
  telegram.checkReminders(); await flush();
  assert.deepStrictEqual(sent.map(m => m.chat_id).sort(), ['777', '888']);
});

test('on-time reminder says «Через час»', async () => {
  sent.length = 0;
  at(60, 'task');
  telegram.checkReminders(); await flush();
  assert.match(sent[0].text, /Через час срок/);
});

test('"срок сегодня" waits for the morning: nothing at 00:05, sent at 09:00, then only once', async () => {
  sent.length = 0;
  const id = db.prepare("INSERT INTO tasks (space_id, section_id, title, due_date) VALUES (?, ?, 'Собрать базы', ?)").run(sp, sec, dates.localDate()).lastInsertRowid;
  db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, uid);
  const at = h => { const d = new Date(); d.setHours(h, 5, 0, 0); return d; };
  telegram.checkDueDates(at(0)); await flush();
  assert.strictEqual(sent.filter(m => m.text.includes('Собрать базы')).length, 0, 'quiet at night');
  telegram.checkDueDates(at(9)); await flush();
  const msg = sent.find(m => m.text.includes('Собрать базы'));
  assert.ok(msg, 'sent in the morning');
  assert.ok(!msg.text.includes('без проекта'));
  telegram.checkDueDates(at(10)); await flush();
  assert.strictEqual(sent.filter(m => m.text.includes('Собрать базы')).length, 1, 'once');
});

test('invitation text for a meeting', async () => {
  sent.length = 0;
  telegram.notifyAssigned(uid, { id: 1, title: 'Планёрка', kind: 'meeting', due_date: '2026-09-26', due_time: '18:30', meeting_url: 'https://meet.google.com/x' }, 'Production', 'Алевтина');
  await flush();
  assert.match(sent[0].text, /зовёт вас на созвон/);
  assert.match(sent[0].text, /26 сентября 2026, 18:30/);
});
