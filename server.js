require('./lib/env');
// Deadlines are wall-clock times of the team (Saint Petersburg). Must be set
// before any Date is created.
process.env.TZ = process.env.TZ || 'Europe/Moscow';
const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');

const { loadUser, requireAuth, requireOwner } = require('./middleware/auth');
const telegram = require('./lib/telegram');
const perms = require('./lib/permissions');
const security = require('./lib/security');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.fmt = require('./lib/view-helpers');

security.checkConfig();
app.disable('x-powered-by');
// Behind Beget/nginx proxy: needed for secure cookies and real client IPs.
app.set('trust proxy', 1);
// Machine-to-machine intake (own token), before the browser login gate.
app.use('/api/outreach', require('./routes/outreach-api'));
app.use(security.basicAuthGate());
app.use(security.headers);

app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// Public static assets (CSS/JS). Uploads are NOT public — served below, after login.
// no-store: a stale cached board.js/task.js after a deploy causes confusion.
const staticOpts = { setHeaders: (res) => res.set('Cache-Control', 'no-store') };
app.use('/css', express.static(path.join(__dirname, 'public', 'css'), staticOpts));
app.use('/js', express.static(path.join(__dirname, 'public', 'js'), staticOpts));
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons'), { maxAge: '7d' }));
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest')));

app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: security.isProd,
}));

app.use(loadUser);

app.use('/', require('./routes/auth'));

app.use(requireAuth);

app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), { setHeaders: (res) => res.set('Cache-Control', 'private, max-age=86400') }));

// Current workspace (PulsAura or a personal one), sidebar spaces, people for assignee pickers.
app.use((req, res, next) => {
  require('./lib/workspace-context').applyWorkspace(req, res, req.session.ws || null);
  next();
});

const { teamOnly } = require('./lib/workspace-context');
app.use('/', require('./routes/dashboard'));
app.use('/profile', require('./routes/profile'));
app.use('/spaces', require('./routes/import'));
app.use('/spaces', require('./routes/spaces'));
app.use('/clients', teamOnly, require('./routes/clients'));
app.use('/projects', require('./routes/projects'));
app.use('/', require('./routes/sections'));
app.use('/', require('./routes/tasks'));
app.use('/feed', teamOnly, require('./routes/feed'));
app.use('/users', requireOwner, require('./routes/users'));
app.use('/trash', require('./routes/trash'));
app.use('/workspaces', require('./routes/workspaces'));

app.use((req, res) => res.status(404).send('Страница не найдена'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`team-crm запущен: http://localhost:${PORT}`);
  telegram.start();
  const trash = require('./lib/trash');
  trash.purgeExpired();
  setInterval(() => trash.purgeExpired(), 6 * 60 * 60 * 1000).unref();
});
