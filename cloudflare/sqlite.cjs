const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
class DurableDatabase {
  constructor(storage, files) { this.storage = storage; this.files = files; this.depth = 0; this.filePath = 'cloudflare-sqlite'; }
  exec(sql) { return this.storage.sql.exec(sql).toArray(); }
  query(sql, parameters) {
    // Durable Objects allow 100 bound values; large boards use safely escaped literals.
    return parameters.length > 100
      ? this.storage.sql.exec(require('./sql-parameters.cjs').expand(sql, parameters))
      : this.storage.sql.exec(sql, ...parameters);
  }
  prepare(sql) {
    return {
      all: (...parameters) => this.query(sql, parameters).toArray(),
      get: (...parameters) => this.query(sql, parameters).toArray()[0],
      run: (...parameters) => {
        this.query(sql, parameters).toArray();
        return this.storage.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').toArray()[0];
      },
    };
  }
  get isTransaction() { return this.depth > 0; }
  transactionSync(fn) {
    if (this.depth) return fn();
    return this.storage.transactionSync(() => {
      this.depth++;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('SQLite transactions must be synchronous');
        return result;
      } finally { this.depth--; }
    });
  }
  tables() {
    return this.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1) != '_' AND name NOT IN ('crm_runtime_state','crm_telegram_outbox') ORDER BY name").all().map(r => r.name);
  }
  snapshot() {
    const tables = {};
    this.transactionSync(() => {
      for (const name of this.tables()) tables[name] = this.prepare('SELECT * FROM ' + quote(name)).all();
    });
    return { format: 'pulsaura-crm', version: 1, createdAt: new Date().toISOString(), tables };
  }
  async makeBackup(label = '', keep = label ? 10 : 30) {
    const snapshot = this.snapshot();
    const suffix = label ? '_' + label.replace(/[^a-z0-9-]/gi, '') : '';
    const name = 'backups/team-crm-' + snapshot.createdAt.replace(/[:.]/g, '-') + suffix + '.json';
    await this.files.put(name, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });
    const existing = await this.files.list({ prefix: 'backups/' });
    const sameKind = existing.objects.filter(o => suffix ? o.key.endsWith(suffix + '.json') : /Z\.json$/.test(o.key)).sort((a,b) => b.key.localeCompare(a.key));
    if (sameKind.length > keep) await this.files.delete(sameKind.slice(keep).map(o => o.key));
    return name;
  }
  restore(snapshot) {
    if (snapshot?.format !== 'pulsaura-crm' || snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') throw new Error('Invalid CRM backup');
    const names = this.tables();
    if (names.some(name => !Array.isArray(snapshot.tables[name]))) throw new Error('Backup is missing application tables');
    for (const [name, rows] of Object.entries(snapshot.tables)) {
      if (!names.includes(name) || !Array.isArray(rows)) throw new Error('Unknown backup table');
      const columns = this.prepare('PRAGMA table_info(' + quote(name) + ')').all().map(c => c.name);
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Object.keys(row).some(c => !columns.includes(c))) throw new Error('Invalid backup columns');
      }
    }
    this.transactionSync(() => {
      this.exec('PRAGMA defer_foreign_keys = ON');
      for (const name of names) this.exec('DELETE FROM ' + quote(name));
      for (const name of names) {
        for (const row of snapshot.tables[name]) {
          const columns = Object.keys(row);
          this.prepare('INSERT OR REPLACE INTO ' + quote(name) + ' (' + columns.map(quote).join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...columns.map(c => row[c]));
        }
      }
      const violations = this.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error('Backup has invalid references');
      this.exec('DELETE FROM crm_runtime_state');
      this.exec('DELETE FROM crm_telegram_outbox');
    });
  }
}
module.exports = { DurableDatabase };
