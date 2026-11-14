const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { FileRepository, CHUNK_BYTES } = require('../cloudflare/file-repository.cjs');
function repository(options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(sql,...values) {
      let rows;
      if (/^\s*CREATE\b/i.test(sql)) { sqlite.exec(sql); rows = []; }
      else rows = sqlite.prepare(sql).all(...values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      return { toArray: () => rows };
    } },
    transactionSync(fn) {
      sqlite.exec('BEGIN');
      try { const result = fn(); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const result = new FileRepository(storage, options); result.initialize();
  return result;
}
function put(store,key,body) {
  const bytes = Buffer.from(body), version = store.begin();
  try {
    for (let offset=0,index=0;offset<bytes.byteLength;offset+=CHUNK_BYTES,index++) store.append(version,index,bytes.subarray(offset,offset+CHUNK_BYTES));
    return store.commit(key,version,bytes.byteLength,'application/octet-stream');
  } catch(error) { store.discard(version); throw error; }
}
const bytes = object => Buffer.concat(object.chunks.map(chunk => Buffer.from(chunk)));
test('binary files span small SQLite rows and survive repository initialization', () => {
  const store=repository(), body=Buffer.alloc(CHUNK_BYTES*5+17,0xa5);
  put(store,'feed/image.png',body); store.initialize();
  const object=store.get('feed/image.png'); assert.deepEqual(bytes(object),body);assert.equal(object.chunks.length,6);
});
test('quota failure preserves the previous file and removes staging data', () => {
  const store=repository({filesBytes:8});put(store,'feed/image.png','old!');
  assert.throws(()=>put(store,'feed/image.png','too-large'),error=>error.status===507);
  assert.equal(bytes(store.get('feed/image.png')).toString(),'old!');assert.equal(store.stats().files.bytes,4);
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM crm_file_chunks')[0].count,1);
});
test('backup archive rotates the oldest copies by count and bytes without deleting images', () => {
  const store=repository({backupCount:2,backupBytes:12});put(store,'feed/image.png','image');
  for(const id of ['01','02','03']) put(store,'backups/'+id+'.json','data');
  assert.deepEqual(store.list('backups/').map(o=>o.key),['backups/02.json','backups/03.json']);
  put(store,'backups/04.json','12345678');
  assert.deepEqual(store.list('backups/').map(o=>o.key),['backups/03.json','backups/04.json']);assert.equal(store.stats().backups.bytes,12);
  assert.equal(bytes(store.get('feed/image.png')).toString(),'image');
});
test('oversized backups cannot evict the last valid copy', () => {
  const store=repository({backupBytes:3});put(store,'backups/old.json','ok');
  assert.throws(()=>put(store,'backups/new.json','long'),error=>error.status===507);
  assert.equal(bytes(store.get('backups/old.json')).toString(),'ok');assert.equal(store.stats().backups.count,1);
});
test('incomplete uploads are never published and do not change previous metadata', () => {
  const store=repository();put(store,'feed/image.png','valid');const version=store.begin();
  store.append(version,1,Buffer.from('x'));assert.throws(()=>store.commit('feed/image.png',version,1,'image/png'),/Incomplete/);store.discard(version);
  assert.equal(bytes(store.get('feed/image.png')).toString(),'valid');
});
test('restart cleans interrupted upload chunks without touching committed files', () => {
  const store=repository();put(store,'feed/image.png','valid');const version=store.begin();store.append(version,0,Buffer.from('unfinished'));
  store.initialize();assert.equal(store.rows('SELECT COUNT(*) AS count FROM crm_file_chunks WHERE version=?',version)[0].count,0);
  assert.equal(bytes(store.get('feed/image.png')).toString(),'valid');
});
test('deleting or replacing an object preserves an already captured download', () => {
  const store=repository();put(store,'feed/image.png','first');const download=store.get('feed/image.png');
  put(store,'feed/image.png','next');assert.equal(store.stats().files.bytes,4);
  store.delete(['feed/image.png']);assert.equal(store.get('feed/image.png'),null);assert.equal(bytes(download).toString(),'first');assert.equal(store.stats().files.bytes,0);
});
test('batch deletion rolls back if a key is outside the private file prefixes', () => {
  const store=repository();put(store,'feed/image.png','valid');
  assert.throws(()=>store.delete(['feed/image.png','../backups.json']),error=>error.status===400);
  assert.equal(bytes(store.get('feed/image.png')).toString(),'valid');
});
