const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { timingSafeEqual } = require('node:crypto');
const db = require('../db');
const { current } = require('../lib/runtime');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
// Full database copies include private workspaces; require the operator's secret as well as an owner login.
router.use((req,res,next) => {
  const expected=Buffer.from(current().env.BACKUP_ADMIN_TOKEN || '');
  const actual=Buffer.from(req.get('X-CRM-Backup-Token') || '');
  if(expected.length<32 || expected.length!==actual.length || !timingSafeEqual(expected,actual)) return res.sendStatus(403);
  next();
});
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.get('/storage', route(async (_req,res) => res.json(await current().files.stats())));
router.get('/', route(async (_req, res) => {
  const list = await current().files.list({ prefix: 'backups/' });
  res.json({ backups: list.objects.map(o => ({ name: o.key.slice(8), createdAt: o.uploaded, size: o.size })) });
}));
router.post('/', route(async (_req, res) => {
  res.status(201).json({ name: (await db.makeBackup('manual')).slice(8) });
}));
router.get('/:filename', route(async (req, res) => {
  if (!/^team-crm-[\w.-]+\.json$/.test(req.params.filename)) return res.sendStatus(404);
  const object = await current().files.get('backups/' + req.params.filename);
  if (!object) return res.sendStatus(404);
  res.attachment(req.params.filename).send(Buffer.from(await object.arrayBuffer()));
}));
router.post('/restore', upload.single('backup'), route(async (req, res) => {
  if (!req.file || req.body.confirm !== 'RESTORE') return res.status(400).json({ error: 'backup_and_confirmation_required' });
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) return res.sendStatus(403);
  let snapshot;
  try { snapshot = JSON.parse(req.file.buffer.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_backup' }); }
  await db.makeBackup('before-restore');
  db.restore(snapshot);
  req.session = null;
  res.json({ ok: true, next: '/login' });
}));
module.exports = { router };
