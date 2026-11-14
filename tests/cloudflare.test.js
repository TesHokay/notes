const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
process.env.CRM_CLOUDFLARE='1';process.env.TZ='Europe/Moscow';process.env.TELEGRAM_BOT_TOKEN='unit-test-token';
process.env.DB_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'crm-cloudflare-')),'test.db');
const native=require('../db');
native.exec('CREATE TABLE IF NOT EXISTS crm_telegram_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0)');
native.exec('CREATE TABLE IF NOT EXISTS crm_runtime_state (namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(namespace,key))');
const {DurableDatabase}=require('../cloudflare/sqlite.cjs');
const fileStore={objects:new Map(),async put(key,value){this.objects.set(key,value);},async list(){return {objects:[...this.objects.keys()].map(key=>({key}))};},async delete(keys){for(const key of [keys].flat()) this.objects.delete(key);}};
const database=new DurableDatabase({sql:{exec(sql,...parameters){let values;if(/^\s*(CREATE|ALTER)\b/i.test(sql)&&!parameters.length){native.exec(sql);values=[];}else values=native.prepare(sql).all(...parameters);return {toArray:()=>values};}},transactionSync(fn){native.exec('BEGIN');try{const result=fn();native.exec('COMMIT');return result;}catch(error){native.exec('ROLLBACK');throw error;}}},fileStore);
test('Cloudflare SQL adapter rolls back nested business transactions',()=>{
  assert.throws(()=>database.transactionSync(()=>{database.prepare("INSERT INTO users(name,email,password_hash) VALUES('Rollback','rollback@example.test','hash')").run();database.transactionSync(()=>{throw new Error('cancel');});}),/cancel/);
  assert.equal(database.prepare("SELECT id FROM users WHERE email='rollback@example.test'").get(),undefined);
});
test('large parameter lists preserve quoted question marks and escape hostile strings',()=>{
  const hostile="'; DROP TABLE users; --";
  const parameters=[hostile,1,...Array.from({length:150},(_,i)=>i+1)];
  const result=database.prepare("SELECT ? AS value, '?' AS question /* ? */ WHERE ? IN ("+parameters.slice(2).map(()=>'?').join(',')+')').get(...parameters);
  assert.equal(result.value,hostile);assert.equal(result.question,'?');assert.ok(database.prepare('SELECT count(*) AS count FROM users').get());
});
test('large import previews survive store recreation and expire completely',()=>{
  const {createStore}=require('../lib/transient-store');const expected={planned:'Клиент '.repeat(100000)};
  createStore('preview',10000).set('token',expected);assert.deepEqual(createStore('preview',10000).get('token'),expected);
  native.prepare('UPDATE crm_runtime_state SET expires_at=0').run();assert.equal(createStore('preview',10000).get('token'),undefined);
});
test('Worker clock preserves Moscow midnight, calendar days and UTC export',()=>{
  const dates=require('../lib/dates');const now=new Date('2026-12-31T22:30:00Z');
  assert.equal(dates.localDate(now),'2027-01-01');assert.equal(dates.localTime(now),'01:30');assert.equal(dates.tzOffsetMinutes(now),180);
  assert.equal(dates.zonedDate('2027-01-01','01:30').toISOString(),'2026-12-31T22:30:00.000Z');assert.equal(dates.addDays('2026-12-31',1),'2027-01-01');
});
test('durable file backup restores rows and rejects broken foreign keys atomically',async()=>{
  database.prepare("INSERT INTO users(name,email,password_hash) VALUES('Backup','backup@example.test','hash')").run();
  const name=await database.makeBackup('unit');const snapshot=JSON.parse(fileStore.objects.get(name));
  database.prepare("UPDATE users SET name='changed' WHERE email='backup@example.test'").run();database.restore(snapshot);
  assert.equal(database.prepare("SELECT name FROM users WHERE email='backup@example.test'").get().name,'Backup');
  const broken=structuredClone(snapshot);broken.tables.spaces.push({id:99999,name:'Invalid',workspace_id:99999});
  assert.throws(()=>database.restore(broken));assert.equal(database.prepare("SELECT name FROM users WHERE email='backup@example.test'").get().name,'Backup');
});
test('Telegram outbox retains failed deliveries and removes confirmed deliveries',async()=>{
  const telegram=require('../lib/telegram');const originalFetch=global.fetch;
  try {
    global.fetch=async()=>({json:async()=>({ok:false,description:'test failure'})});
    await telegram.sendMessage('123','test');await telegram.flushOutbox();
    assert.equal(native.prepare('SELECT count(*) AS count FROM crm_telegram_outbox').get().count,1);
    native.prepare('UPDATE crm_telegram_outbox SET available_at=0').run();global.fetch=async()=>({json:async()=>({ok:true})});await telegram.flushOutbox();
    assert.equal(native.prepare('SELECT count(*) AS count FROM crm_telegram_outbox').get().count,0);
  } finally {global.fetch=originalFetch;}
});

test('workspace permissions follow restored ownership instead of stale process memory',()=>{
  const permissions=require('../lib/permissions');
  const first=database.prepare("SELECT id FROM users WHERE email='backup@example.test'").get().id;
  const second=database.prepare("INSERT INTO users(name,email,password_hash) VALUES('Second','second@example.test','hash')").run().lastInsertRowid;
  const ws=database.prepare("INSERT INTO workspaces(name,owner_id) VALUES('Private',?)").run(first).lastInsertRowid;
  const space=database.prepare("INSERT INTO spaces(name,workspace_id) VALUES('Private',?)").run(ws).lastInsertRowid;
  assert.equal(permissions.personalOwnerOf(space),first);
  database.prepare('UPDATE workspaces SET owner_id=? WHERE id=?').run(second,ws);
  assert.equal(permissions.personalOwnerOf(space),second);
});

test('login limiter persists every failed attempt across module recreation',()=>{
  let security=require('../lib/security');
  security.loginLimiter.reset('restart-test');
  for(let i=0;i<8;i++) security.loginLimiter.fail('restart-test');
  assert.equal(security.loginLimiter.blocked('restart-test'),true);
  delete require.cache[require.resolve('../lib/security')];
  security=require('../lib/security');
  assert.equal(security.loginLimiter.blocked('restart-test'),true);
  security.loginLimiter.reset('restart-test');
});
