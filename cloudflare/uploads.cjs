const express = require('express');
const crypto = require('node:crypto');
const { current } = require('../lib/runtime');
const router = express.Router();
router.get('/feed/:filename', async (req, res, next) => {
  try {
    if (!/^[\w.-]+$/.test(req.params.filename)) return res.sendStatus(404);
    const object = await current().env.FILES.get('feed/' + req.params.filename);
    if (!object) return res.sendStatus(404);
    res.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(await object.arrayBuffer()));
  } catch (error) { next(error); }
});
async function save(file) {
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.mimetype];
  if (!ext) throw new Error('Unsupported image format');
  const filename = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
  await current().env.FILES.put('feed/' + filename, file.buffer, { httpMetadata: { contentType: file.mimetype } });
  return '/uploads/feed/' + filename;
}
module.exports = { router, save };
