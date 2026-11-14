// Loads the project's .env (by absolute path, independent of cwd). TZ from .env wins over a
// TZ already set by the host (Beget containers run in UTC): deadlines, reminders and backup
// names must use the team's time zone.
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

const file = path.join(__dirname, '..', '.env');
dotenv.config({ path: file });
if (fs.existsSync(file)) {
  const tz = dotenv.parse(fs.readFileSync(file)).TZ;
  if (tz) process.env.TZ = tz;
}
