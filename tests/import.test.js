const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-imp-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const db = require('../db');
const imp = require('../lib/import-service');

const user = { id: db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Никита Иванов', 'nikita@x', 'x')").run().lastInsertRowid };
const spaceId = db.prepare("INSERT INTO spaces (name, card_mode) VALUES ('Sales', 'client')").run().lastInsertRowid;
['Новый лид', 'Контакт', 'КП / Оффер'].forEach((n, i) => db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)').run(spaceId, n, i));
const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId);

test('xlsx template: preview then apply creates clients, cards, actions', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'pulsaura-import-template.xlsx'));
  const planned = await imp.plan({ buffer, filename: 't.xlsx', space });
  assert.strictEqual(planned.stats.total, 2);
  assert.strictEqual(planned.stats.create, 2);
  const fish = planned.rows.find(r => r.name === 'Fish Shop');
  assert.strictEqual(fish.section.name, 'КП / Оффер');
  assert.strictEqual(fish.owner.id, user.id); // matched by first name
  assert.strictEqual(fish.action_date, '2026-09-26');
  assert.strictEqual(fish.action_time, '18:00');
  assert.strictEqual(fish.next_touch, '2026-10-01');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 0, 'preview must not write');

  const res = imp.apply({ planned, space, user });
  assert.deepStrictEqual({ c: res.created, a: res.actions }, { c: 2, a: 2 });
  const card = db.prepare("SELECT t.*, s.name AS sec FROM tasks t JOIN sections s ON s.id = t.section_id WHERE t.title = 'Fish Shop'").get();
  assert.strictEqual(card.sec, 'КП / Оффер');
  const sub = db.prepare('SELECT * FROM subtasks WHERE task_id = ?').get(card.id);
  assert.strictEqual(sub.title, 'Отправить КП');
  assert.strictEqual(sub.assignee_id, user.id);
  const c = db.prepare("SELECT * FROM clients WHERE name = 'Fish Shop'").get();
  assert.strictEqual(c.contact_telegram, '@ivanfish');
  assert.strictEqual(c.next_touch_at, '2026-10-01');
});

test('re-import of the same file does not duplicate anything', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'pulsaura-import-template.xlsx'));
  const planned = await imp.plan({ buffer, filename: 't.xlsx', space });
  assert.strictEqual(planned.stats.update, 2);
  imp.apply({ planned, space, user });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM subtasks').get().c, 2);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM client_events WHERE type = 'contact_log'").get().c, 1);
});

test('Excel "CSV (;)" in windows-1251 with other header names; stage move; errors', async () => {
  const csv = 'Компания;Статус;Менеджер;Задача;Срок\r\nFish Shop;Контакт;nikita@x;Перезвонить;25.10\r\n;Контакт;;;\r\nНовый клиент;Непонятный этап;Вася;;31.02.2026\r\n';
  const bytes = Buffer.from(Array.from(csv).map(ch => {
    const code = ch.charCodeAt(0);
    if (code < 128) return code;
    if (code >= 0x410 && code <= 0x44F) return code - 0x410 + 0xC0; // А..я
    if (code === 0x401) return 0xA8; if (code === 0x451) return 0xB8;
    return 0x3F;
  }));
  const planned = await imp.plan({ buffer: bytes, filename: 'base.csv', space });
  assert.strictEqual(planned.rows.length, 3);
  assert.ok(planned.rows[1].errors.length, 'empty client name is an error');
  const bad = planned.rows[2];
  assert.ok(bad.warnings.some(w => w.includes('Непонятный этап')));
  assert.ok(bad.warnings.some(w => w.includes('Вася')));
  assert.ok(bad.warnings.some(w => w.includes('нет такой даты')));
  const res = imp.apply({ planned, space, user });
  assert.strictEqual(res.moved, 1);
  assert.strictEqual(res.skipped, 1);
  const card = db.prepare("SELECT s.name FROM tasks t JOIN sections s ON s.id = t.section_id WHERE t.title = 'Fish Shop'").get();
  assert.strictEqual(card.name, 'Контакт');
});
