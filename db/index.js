const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'team-crm.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
// SQLite's NOCASE only folds Latin letters — "Кофейня" ≠ "кофейня". ru_lower() folds Cyrillic too.
db.function('ru_lower', { deterministic: true }, s => (s == null ? null : String(s).toLocaleLowerCase('ru')));
db.exec('PRAGMA foreign_keys = ON');

require('./schema').initializeSchema(db);

db.filePath = dbPath;
module.exports = db;
