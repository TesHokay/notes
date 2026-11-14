const db = require('../db');

function loadUser(req, res, next) {
  const userId = req.session && req.session.userId;
  if (userId) {
    req.user = db.prepare('SELECT id, name, email, is_owner, can_see_clients, is_external, telegram_chat_id FROM users WHERE id = ?').get(userId);
  }
  res.locals.user = req.user || null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    // Remember where the person was going (only plain page opens) so login returns them there.
    const next = req.method === 'GET' && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/login${next}`);
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || !req.user.is_owner) return res.status(403).send('Доступ только для владельцев');
  next();
}

module.exports = { loadUser, requireAuth, requireOwner };
