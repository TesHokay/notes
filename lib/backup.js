// Consistent SQLite snapshot (safe while the app is running) into <data>/backups/,
// keeping the newest KEEP files. Used by scripts/backup.js and before destructive actions.
const path = require('node:path');
const fs = require('node:fs');

// Rotation is per kind: daily snapshots (no label) keep BACKUP_KEEP (30), each label keeps its own
// `keep` — so frequent deploy snapshots never push the daily ones out.
function makeBackup(db, dbPath, label = '', keep = label ? 10 : Number(process.env.BACKUP_KEEP || 30)) {
  if (db.makeBackup) return db.makeBackup(label, keep);
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const suffix = label ? `_${label.replace(/[^a-z0-9-]/gi, '')}` : '';
  const file = path.join(dir, `team-crm-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${suffix}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const sameKind = suffix
    ? new RegExp(`^team-crm-.*${suffix}\\.db$`)
    : /^team-crm-\d{4}-\d{2}-\d{2}_\d{4,6}\.db$/;
  const all = fs.readdirSync(dir).filter(f => sameKind.test(f)).sort();
  all.slice(0, Math.max(0, all.length - keep)).forEach(f => fs.unlinkSync(path.join(dir, f)));
  return file;
}

module.exports = { makeBackup };
