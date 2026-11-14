// Sales pipelines per salesperson: clients don't merge across pipelines, each sees only their own.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sales-')), 't.db');
const db = require('../db');
const perms = require('../lib/permissions');
const { findClientForSpace } = require('../lib/task-service');

const user = (name, owner = 0) => ({ id: db.prepare('INSERT INTO users (name, email, password_hash, is_owner) VALUES (?, ?, ?, ?)').run(name, `${name}@x`, 'x', owner).lastInsertRowid, name, is_owner: owner });
const boss = user('Даня', 1);
const vika = user('Вика');
const petya = user('Петя');

function pipeline(name, member) {
  const sp = db.prepare("INSERT INTO spaces (name, card_mode) VALUES (?, 'client')").run(name).lastInsertRowid;
  const sec = db.prepare("INSERT INTO sections (space_id, name) VALUES (?, 'Новый лид')").run(sp).lastInsertRowid;
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')").run(sp, member.id);
  return { sp, sec };
}
function lead(p, name) {
  let c = findClientForSpace(name, p.sp);
  if (!c) c = { id: db.prepare('INSERT INTO clients (name) VALUES (?)').run(name).lastInsertRowid };
  db.prepare('INSERT INTO tasks (space_id, section_id, client_id, title) VALUES (?, ?, ?, ?)').run(p.sp, p.sec, c.id, name);
  return c.id;
}

test('same lead name in two pipelines → two separate clients; each salesperson sees only theirs', () => {
  const pv = pipeline('Sales · Вика', vika);
  const pp = pipeline('Sales · Петя', petya);
  const a = lead(pv, 'Кофейня Луч');
  const b = lead(pp, 'Кофейня Луч');
  assert.notStrictEqual(a, b, 'not merged');
  assert.strictEqual(lead(pv, 'кофейня луч'), a, 'same pipeline → same client');

  assert.ok(perms.canSeeClients(vika), 'salesperson gets «Мои клиенты»');
  assert.strictEqual(perms.canSeeAllClients(vika), false);
  assert.ok(perms.canSeeClient(vika, a));
  assert.strictEqual(perms.canSeeClient(vika, b), false, "not Petya's client");
  assert.ok(perms.canSeeClient(boss, a) && perms.canSeeClient(boss, b), 'owner sees all');
});

test('cards know how many days they sit in the current column', () => {
  const { enrichForCards, moveTask } = require('../lib/task-service');
  const p = pipeline('Sales · дни', vika);
  const sec2 = db.prepare("INSERT INTO sections (space_id, name, position) VALUES (?, 'Контакт', 1)").run(p.sp).lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (space_id, section_id, title, created_at) VALUES (?, ?, 'Старый лид', datetime('now', '-20 days'))").run(p.sp, p.sec).lastInsertRowid;
  const card = () => enrichForCards([db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)])[0];
  assert.strictEqual(card().stage_days, 20, 'never moved → days since created');
  moveTask({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), sectionId: sec2, userId: vika.id });
  assert.strictEqual(card().stage_days, 0, 'just moved → 0');
});

test('phone numbers become tel: / wa.me digits', () => {
  const { phoneDigits } = require('../lib/view-helpers');
  assert.strictEqual(phoneDigits('8 (912) 345-67-89'), '79123456789');
  assert.strictEqual(phoneDigits('+7 912 345 67 89', true), '+79123456789');
  assert.strictEqual(phoneDigits('9123456789'), '79123456789');
  assert.strictEqual(phoneDigits(''), '');
});

test('lead type: agency / business parsed from free text', () => {
  const { parseLeadType } = require('../lib/view-helpers');
  assert.strictEqual(parseLeadType('Агентство'), 'agency');
  assert.strictEqual(parseLeadType('рекламное агентство'), 'agency');
  assert.strictEqual(parseLeadType('Бизнес'), 'business');
  assert.strictEqual(parseLeadType('business'), 'business');
  assert.strictEqual(parseLeadType(''), '');
  assert.strictEqual(parseLeadType('что-то'), '');
  db.prepare("UPDATE clients SET lead_type = 'agency' WHERE id = 1").run();
  assert.strictEqual(db.prepare('SELECT lead_type FROM clients WHERE id = 1').get().lead_type, 'agency');
});
