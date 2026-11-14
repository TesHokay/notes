const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const db = require('../db');

const router = express.Router();

const upload = multer({
  storage: process.env.CRM_CLOUDFLARE ? multer.memoryStorage() : multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'uploads', 'feed'),
    filename: (req, file, cb) => {
      // Extension comes from the validated MIME type, never from the user's filename.
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.mimetype] || '.bin';
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype));
  },
});

function getChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY position').all();
}

router.get('/', (req, res) => {
  const channels = getChannels();
  res.redirect(`/feed/${channels[0] ? channels[0].name : 'general'}`);
});

router.get('/:channel', (req, res) => {
  const channels = getChannels();
  const channel = channels.find(c => c.name === req.params.channel);
  if (!channel) return res.status(404).send('Канал не найден');

  const posts = db.prepare(`
    SELECT p.*, u.name AS author_name
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.channel_id = ?
    ORDER BY p.created_at DESC
  `).all(channel.id);

  const postIds = posts.map(p => p.id);

  const commentsByPost = {};
  const reactionsByPost = {};

  if (postIds.length) {
    const comments = db.prepare(`
      SELECT c.*, u.name AS author_name FROM post_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id IN (${postIds.map(() => '?').join(',')})
      ORDER BY c.created_at ASC
    `).all(...postIds);
    comments.forEach(c => (commentsByPost[c.post_id] ||= []).push(c));

    const reactions = db.prepare(`
      SELECT post_id, emoji, COUNT(*) AS count,
        MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
      FROM post_reactions
      WHERE post_id IN (${postIds.map(() => '?').join(',')})
      GROUP BY post_id, emoji
    `).all(req.user.id, ...postIds);
    reactions.forEach(r => (reactionsByPost[r.post_id] ||= []).push(r));
  }

  const feedPosts = posts.map(p => ({
    ...p,
    comments: commentsByPost[p.id] || [],
    reactions: reactionsByPost[p.id] || [],
  }));

  res.render('feed', {
    channels, channel, posts: feedPosts,
    activeNav: 'feed', title: `#${channel.name}`,
  });
});

router.post('/:channel', upload.single('image'), async (req, res, next) => {
  try {
  const channel = getChannels().find(c => c.name === req.params.channel);
  if (!channel) return res.status(404).send('Канал не найден');

  const body = (req.body.body || '').trim();
  if (!body && !req.file) return res.redirect(`/feed/${channel.name}`);

  let imagePath = req.file ? `/uploads/feed/${req.file.filename}` : null;
  if (req.file && process.env.CRM_CLOUDFLARE) {
    imagePath = await require('../cloudflare/uploads.cjs').save(req.file);
  }
  db.prepare('INSERT INTO posts (channel_id, user_id, body, image_path) VALUES (?, ?, ?, ?)')
    .run(channel.id, req.user.id, body, imagePath);

  res.redirect(`/feed/${channel.name}`);
  } catch (err) { next(err); }
});

router.post('/posts/:id/comments', (req, res) => {
  const post = db.prepare('SELECT p.*, c.name AS channel_name FROM posts p JOIN channels c ON c.id = p.channel_id WHERE p.id = ?').get(req.params.id);
  if (!post) return res.status(404).send('Пост не найден');
  const body = (req.body.body || '').trim();
  if (body) db.prepare('INSERT INTO post_comments (post_id, user_id, body) VALUES (?, ?, ?)').run(post.id, req.user.id, body);
  res.redirect(`/feed/${post.channel_name}`);
});

router.post('/posts/:id/reactions', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_found' });
  const emoji = (req.body.emoji || '').trim();
  if (!emoji) return res.status(400).json({ error: 'emoji_required' });

  const existing = db.prepare('SELECT 1 FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').get(post.id, req.user.id, emoji);
  if (existing) {
    db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').run(post.id, req.user.id, emoji);
  } else {
    db.prepare('INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(post.id, req.user.id, emoji);
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM post_reactions WHERE post_id = ? AND emoji = ?').get(post.id, emoji).c;
  res.json({ ok: true, count, mine: !existing });
});

router.post('/posts/:id/delete', (req, res) => {
  const post = db.prepare('SELECT p.*, c.name AS channel_name FROM posts p JOIN channels c ON c.id = p.channel_id WHERE p.id = ?').get(req.params.id);
  if (!post) return res.status(404).send('Пост не найден');
  if (post.user_id !== req.user.id && !req.user.is_owner) return res.status(403).send('Недостаточно прав');
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  res.redirect(`/feed/${post.channel_name}`);
});

module.exports = router;
