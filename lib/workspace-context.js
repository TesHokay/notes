// Current workspace for a request: null = PulsAura, or a personal workspace the user owns or
// was invited to. Stored in the session; opening a space/task from another workspace (e.g. a
// Telegram link) switches to it so the sidebar matches what's on screen. Invited guests
// (users.is_external) never get PulsAura — they land in one of their workspaces.
const db = require('../db');
const perms = require('./permissions');

function applyWorkspace(req, res, wsId) {
  let ws = wsId ? perms.accessibleWorkspace(req.user, wsId) : null;
  const list = perms.workspacesFor(req.user);
  if (!ws && req.user.is_external && list.length) ws = perms.accessibleWorkspace(req.user, list[0].id);
  req.session.ws = ws ? ws.id : null;
  req.ws = ws;
  res.locals.ws = ws;
  res.locals.myWorkspaces = list;
  res.locals.navSpaces = perms.visibleSpaces(req.user, ws ? ws.id : null);
  res.locals.allUsers = perms.assignableUsers(ws ? ws.id : null);
  // Sidebar «Клиенты»: whole base for owners/granted, «Мои клиенты» for salespeople.
  res.locals.clientsNav = perms.canSeeAllClients(req.user) ? 'Клиенты' : perms.canSeeClients(req.user) ? 'Мои клиенты' : null;
  return ws;
}

// Switch to the workspace a space belongs to, if it differs from the current one.
function followSpace(req, res, space) {
  const target = space.workspace_id || null;
  const current = req.ws ? req.ws.id : null;
  if (target !== current) applyWorkspace(req, res, target);
}

// Invited guests may only use their personal workspaces (+ profile, trash, logout).
function teamOnly(req, res, next) {
  if (req.user.is_external) return res.status(403).send('Этот раздел только для команды PulsAura.');
  next();
}

module.exports = { applyWorkspace, followSpace, teamOnly };
