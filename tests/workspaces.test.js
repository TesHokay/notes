// Personal workspaces are visible only to their owner — PulsAura owners included.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ws-')), 't.db');
const db = require('../db');
const perms = require('../lib/permissions');
const trash = require('../lib/trash');

const mk = (name, owner) => ({ id: db.prepare('INSERT INTO users (name, email, password_hash, is_owner) VALUES (?, ?, ?, ?)').run(name, `${name}@x`, 'x', owner ? 1 : 0).lastInsertRowid, name, is_owner: owner ? 1 : 0 });
const boss = mk('Даня', true);
const stas = mk('Стас', false);

const teamSpace = db.prepare("INSERT INTO spaces (name) VALUES ('Production')").run().lastInsertRowid;
const lifeWs = db.prepare("INSERT INTO workspaces (name, owner_id) VALUES ('Life', ?)").run(stas.id).lastInsertRowid;
const lifeSpace = db.prepare("INSERT INTO spaces (name, workspace_id) VALUES ('Дом', ?)").run(lifeWs).lastInsertRowid;
const sec = db.prepare("INSERT INTO sections (space_id, name) VALUES (?, 'A')").run(lifeSpace).lastInsertRowid;
const lifeTask = db.prepare("INSERT INTO tasks (space_id, section_id, title) VALUES (?, ?, 'Купить продукты')").run(lifeSpace, sec).lastInsertRowid;
const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(lifeSpace);
const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(lifeTask);

test('owner of a personal workspace is its only owner', () => {
  assert.strictEqual(perms.getSpaceRole(stas, lifeSpace), 'owner');
  assert.ok(perms.canSeeTask(stas, task, space));
  assert.deepStrictEqual(perms.visibleSpaces(stas, lifeWs).map(s => s.id), [lifeSpace]);
});

test('a PulsAura owner does not see someone else\'s personal workspace', () => {
  assert.strictEqual(perms.getSpaceRole(boss, lifeSpace), null);
  assert.strictEqual(perms.canSeeTask(boss, task, space), false);
  assert.ok(!perms.visibleSpaces(boss).some(s => s.id === lifeSpace), 'not in PulsAura sidebar');
  assert.deepStrictEqual(perms.visibleSpaces(boss, lifeWs), [], 'cannot open it as a workspace either');
  assert.strictEqual(perms.ownWorkspace(boss, lifeWs), null);
  assert.ok(perms.visibleSpaces(boss).some(s => s.id === teamSpace), 'team spaces still visible');
});

test('only the owner can be assigned in a personal space', () => {
  assert.ok(perms.canAssign(lifeSpace, stas.id));
  assert.strictEqual(perms.canAssign(lifeSpace, boss.id), false);
  assert.ok(perms.canAssign(teamSpace, boss.id));
});

test('an invited member works in the workspace; a guest account never sees PulsAura', () => {
  const wife = { ...mk('Жена', false), is_external: 1 };
  db.prepare('UPDATE users SET is_external = 1 WHERE id = ?').run(wife.id);
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?)').run(lifeWs, wife.id);

  assert.strictEqual(perms.getSpaceRole(wife, lifeSpace), 'manager');
  assert.ok(perms.canSeeTask(wife, task, space));
  assert.ok(perms.canAssign(lifeSpace, wife.id));
  assert.deepStrictEqual(perms.workspacesFor(wife).map(w => [w.id, w.my_role]), [[lifeWs, 'member']]);
  assert.deepStrictEqual(perms.assignableUsers(lifeWs).map(u => u.name).sort(), ['Жена', 'Стас']);

  // PulsAura stays closed and she doesn't show up there.
  assert.deepStrictEqual(perms.visibleSpaces(wife), []);
  assert.strictEqual(perms.getSpaceRole(wife, teamSpace), null);
  assert.strictEqual(perms.canSeeClients(wife), false);
  assert.ok(!perms.assignableUsers(null).some(u => u.id === wife.id));
  assert.strictEqual(perms.canAssign(teamSpace, wife.id), false);

  // Still invisible to the PulsAura owner, even with a member inside.
  assert.strictEqual(perms.getSpaceRole(boss, lifeSpace), null);
  db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(wife.id);
  assert.strictEqual(perms.getSpaceRole(wife, lifeSpace), null, 'removed member loses access');
});

test('trash: personal items only for their owner', () => {
  trash.trashTask(lifeTask, stas.id);
  assert.strictEqual(trash.listFor(boss).length, 0);
  const mine = trash.listFor(stas);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(trash.canRestore(boss, mine[0]), false);
  assert.ok(trash.restore(mine[0].id, stas).ok);
});
