const { randomUUID } = require('node:crypto');
const CHUNK_BYTES = 256 * 1024;
const IMAGE_BYTES = 8 * 1024 * 1024;
const BACKUP_BYTES = 20 * 1024 * 1024;
class StorageError extends Error {
  constructor(message, status = 507) { super(message); this.status = status; }
}
function limit(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error('Invalid file storage limit');
  return parsed;
}
class FileRepository {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.limits = {
      files: limit(options.filesBytes, 256 * 1024 * 1024, 512 * 1024 * 1024),
      backups: limit(options.backupBytes, 64 * 1024 * 1024, 256 * 1024 * 1024),
      backupCount: limit(options.backupCount, 20, 100),
    };
    if (!this.limits.backupCount) throw new Error('At least one backup must be retained');
  }
  rows(sql, ...values) { return this.storage.sql.exec(sql, ...values).toArray(); }
  initialize() {
    this.storage.transactionSync(() => {
      this.rows(`
        CREATE TABLE IF NOT EXISTS crm_file_objects (
          key TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL CHECK(scope IN ('feed','backups')),
          size INTEGER NOT NULL, content_type TEXT NOT NULL, uploaded INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS crm_file_objects_scope ON crm_file_objects(scope,uploaded,key);
        CREATE TABLE IF NOT EXISTS crm_file_chunks (
          version TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL,
          PRIMARY KEY(version,chunk)
        );
      `);
      // An interrupted upload never becomes visible. Clear its staged chunks after restart.
      this.rows('DELETE FROM crm_file_chunks WHERE version NOT IN (SELECT version FROM crm_file_objects)');
    });
  }
  scope(key) {
    if (typeof key !== 'string' || !/^(feed|backups)\/[A-Za-z0-9_.-]{1,200}$/.test(key)) throw new StorageError('Некорректное имя файла.', 400);
    return key.startsWith('backups/') ? 'backups' : 'feed';
  }
  maxObjectBytes(key) { return this.scope(key) === 'backups' ? BACKUP_BYTES : IMAGE_BYTES; }
  begin() { return randomUUID(); }
  append(version, index, bytes) {
    if (bytes.byteLength > CHUNK_BYTES) throw new StorageError('Слишком большой фрагмент файла.', 413);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.rows('INSERT INTO crm_file_chunks(version,chunk,data) VALUES(?,?,?)', version, index, data);
  }
  discard(version) {
    this.rows('DELETE FROM crm_file_chunks WHERE version=? AND version NOT IN (SELECT version FROM crm_file_objects)', version);
  }
  metadata(key) { return this.rows('SELECT * FROM crm_file_objects WHERE key=?', key)[0]; }
  remove(key) {
    const object = this.metadata(key);
    if (!object) return;
    this.rows('DELETE FROM crm_file_chunks WHERE version=?', object.version);
    this.rows('DELETE FROM crm_file_objects WHERE key=?', key);
  }
  commit(key, version, size, contentType) {
    const scope = this.scope(key);
    if (size > this.maxObjectBytes(key)) throw new StorageError('Файл превышает допустимый размер.', 413);
    return this.storage.transactionSync(() => {
      const staged = this.rows('SELECT COUNT(*) AS count, COALESCE(SUM(length(data)),0) AS size, MIN(chunk) AS first, MAX(chunk) AS last FROM crm_file_chunks WHERE version=?', version)[0];
      if (staged.size !== size || (staged.count && (staged.first !== 0 || staged.last !== staged.count - 1))) throw new Error('Incomplete file upload');
      const old = this.metadata(key);
      const used = this.rows('SELECT COALESCE(SUM(size),0) AS size FROM crm_file_objects WHERE scope=?', scope)[0].size;
      if (scope === 'feed') {
        if (used - (old?.size || 0) + size > this.limits.files) throw new StorageError('Лимит хранения изображений исчерпан. Обратитесь к администратору CRM.');
      } else {
        if (size > this.limits.backups) throw new StorageError('Резервная копия превышает лимит архива. Скачайте экспорт базы отдельно.');
        const existing = this.rows("SELECT key,size FROM crm_file_objects WHERE scope='backups' AND key!=? ORDER BY uploaded,key", key);
        let bytes = used - (old?.size || 0) + size;
        let count = existing.length + 1;
        for (const object of existing) {
          if (bytes <= this.limits.backups && count <= this.limits.backupCount) break;
          this.remove(object.key); bytes -= object.size; count--;
        }
      }
      if (old) this.remove(key);
      const uploaded = Date.now();
      this.rows('INSERT INTO crm_file_objects(key,version,scope,size,content_type,uploaded) VALUES(?,?,?,?,?,?)', key, version, scope, size, contentType || 'application/octet-stream', uploaded);
      return { key, size, uploaded, contentType: contentType || 'application/octet-stream' };
    });
  }
  get(key) {
    this.scope(key);
    const object = this.metadata(key);
    if (!object) return null;
    // Capture one committed version before returning the body, even during replacement/deletion.
    const chunks = this.rows('SELECT data FROM crm_file_chunks WHERE version=? ORDER BY chunk', object.version).map(row => new Uint8Array(row.data));
    if (chunks.reduce((size, chunk) => size + chunk.byteLength, 0) !== object.size) throw new Error('Stored file is incomplete');
    return { ...object, chunks };
  }
  list(prefix = '') {
    return this.rows('SELECT key,size,uploaded,content_type FROM crm_file_objects WHERE substr(key,1,length(?))=? ORDER BY key', prefix, prefix);
  }
  delete(keys) {
    this.storage.transactionSync(() => { for (const key of keys) { this.scope(key); this.remove(key); } });
  }
  stats() {
    const used = Object.fromEntries(this.rows('SELECT scope,SUM(size) AS bytes,COUNT(*) AS count FROM crm_file_objects GROUP BY scope').map(row => [row.scope, row]));
    return {
      files: { bytes: used.feed?.bytes || 0, count: used.feed?.count || 0, limit: this.limits.files },
      backups: { bytes: used.backups?.bytes || 0, count: used.backups?.count || 0, limit: this.limits.backups, maxCount: this.limits.backupCount },
    };
  }
}
module.exports = { FileRepository, StorageError, CHUNK_BYTES };
