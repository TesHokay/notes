// Consistent SQLite backup (safe while the app is running): data/backups/team-crm-YYYY-MM-DD_HHMMSS.db
// Keeps the newest BACKUP_KEEP (default 30) daily files.
// Usage: node scripts/backup.js            — daily (cron)
//        node scripts/backup.js deploy     — before an update, rotated separately (last 10)
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../lib/env');
const { makeBackup } = require('../lib/backup');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'team-crm.db');
const db = new DatabaseSync(dbPath);
const file = makeBackup(db, dbPath, process.argv[2] || '');
db.close();
console.log('backup:', file);
