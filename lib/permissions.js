const db = require('../db');

// Personal workspace a space belongs to ({ wsId, ownerId }), or null for a PulsAura (team) space.
// Read current storage so restored databases cannot reuse stale workspace permissions.
function workspaceOfSpace(spaceId) {
  const row = db.prepare('SELECT s.workspace_id, w.owner_id FROM spaces s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?').get(spaceId);
  return row && row.workspace_id ? { wsId: row.workspace_id, ownerId: row.owner_id } : null;
}
function personalOwnerOf(spaceId) {
  const ws = workspaceOfSpace(spaceId);
  return ws ? ws.ownerId : null;
}

// Role in a personal workspace: 'owner', 'member' (invited) or null.
function workspaceRole(user, wsId) {
  const ws = db.prepare('SELECT owner_id FROM workspaces WHERE id = ?').get(Number(wsId));
  if (!ws) return null;
  if (ws.owner_id === user.id) return 'owner';
  return db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(Number(wsId), user.id) ? 'member' : null;
}

// Personal workspace this user owns, or null.
function ownWorkspace(user, wsId) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ? AND owner_id = ?').get(Number(wsId), user.id) || null;
}

// Personal workspace this user owns or was invited to (with my_role), or null.
function accessibleWorkspace(user, wsId) {
  const role = workspaceRole(user, wsId);
  if (!role) return null;
  return { ...db.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(wsId)), my_role: role };
}

// All personal workspaces the user owns or belongs to.
function workspacesFor(user) {
  return db.prepare(`
    SELECT w.id, w.name, w.icon, CASE WHEN w.owner_id = ? THEN 'owner' ELSE 'member' END AS my_role
    FROM workspaces w
    WHERE w.owner_id = ? OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ?)
    ORDER BY (w.owner_id = ?) DESC, w.created_at
  `).all(user.id, user.id, user.id, user.id);
}

function getSpaceRole(user, spaceId) {
  const ws = workspaceOfSpace(spaceId);
  // Personal workspace spaces: its owner, and invited members working as managers.
  // PulsAura owners don't see them.
  if (ws) {
    const role = workspaceRole(user, ws.wsId);
    return role === 'owner' ? 'owner' : role === 'member' ? 'manager' : null;
  }
  if (user.is_external) return null; // invited guests never get into PulsAura
  if (user.is_owner) return 'owner';
  const row = db.prepare('SELECT role FROM space_members WHERE space_id = ? AND user_id = ?').get(spaceId, user.id);
  return row ? row.role : null;
}

// ws: null = PulsAura (team), or the id of a personal workspace the user can access.
function visibleSpaces(user, ws = null) {
  if (ws) {
    const role = workspaceRole(user, ws);
    if (!role) return [];
    return db.prepare(`SELECT s.*, ? AS my_role FROM spaces s WHERE s.workspace_id = ? ORDER BY s.position, s.id`)
      .all(role === 'owner' ? 'owner' : 'manager', ws);
  }
  if (user.is_external) return [];
  if (user.is_owner) {
    return db.prepare('SELECT * FROM spaces WHERE workspace_id IS NULL ORDER BY position').all();
  }
  return db.prepare(`
    SELECT s.*, sm.role AS my_role FROM spaces s
    JOIN space_members sm ON sm.space_id = s.id
    WHERE sm.user_id = ? AND s.workspace_id IS NULL
    ORDER BY s.position
  `).all(user.id);
}

function canOpenSpace(user, spaceId) {
  return Boolean(getSpaceRole(user, spaceId));
}

function canManageSpace(user, spaceId) {
  const role = getSpaceRole(user, spaceId);
  return role === 'owner' || role === 'manager';
}

function isTaskAssignee(userId, taskId) {
  const direct = db.prepare('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?').get(taskId, userId);
  if (direct) return true;
  const viaSubtask = db.prepare('SELECT 1 FROM subtask_assignees sa JOIN subtasks s ON s.id = sa.subtask_id WHERE s.task_id = ? AND sa.user_id = ?').get(taskId, userId);
  return Boolean(viaSubtask);
}

// space needs: id, task_visibility.
function canSeeTask(user, task, space, precomputedSpaceRole) {
  const spaceRole = precomputedSpaceRole !== undefined ? precomputedSpaceRole : getSpaceRole(user, space.id);
  if (spaceRole === 'owner') return true;
  if (workspaceOfSpace(space.id)) return spaceRole === 'manager'; // personal workspace: owner + invited members
  if (!spaceRole) return !user.is_external && isTaskAssignee(user.id, task.id);
  if (spaceRole === 'manager') return true;
  if (spaceRole === 'guest') return isTaskAssignee(user.id, task.id);
  if (space.task_visibility === 'all_members') return true;
  return isTaskAssignee(user.id, task.id);
}

// In a personal space only its owner and members can be assignees; in PulsAura — not invited guests.
function canAssign(spaceId, userId) {
  const ws = workspaceOfSpace(spaceId);
  if (ws) return Boolean(workspaceRole({ id: Number(userId) }, ws.wsId));
  const u = db.prepare('SELECT is_external FROM users WHERE id = ?').get(Number(userId));
  return Boolean(u && !u.is_external);
}

// People who can be assigned in a workspace: PulsAura staff (wsId null) or owner + members.
function assignableUsers(wsId) {
  if (!wsId) return db.prepare('SELECT id, name FROM users WHERE is_external = 0 ORDER BY name').all();
  return db.prepare(`
    SELECT u.id, u.name FROM users u
    WHERE u.id = (SELECT owner_id FROM workspaces WHERE id = ?)
       OR u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?)
    ORDER BY u.name
  `).all(wsId, wsId);
}

// The whole client base with contacts and notes: owners + people an owner granted it to.
function canSeeAllClients(user) {
  return Boolean(user && !user.is_external && (user.is_owner || user.can_see_clients));
}

// Working with clients from Sales cards (follow-up, hold, contact log, client search): also any
// non-guest member of a client-mode (Sales-style) space — a salesperson in their own pipeline.
function canWorkWithClients(user) {
  if (canSeeAllClients(user)) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm.space_id
    WHERE sm.user_id = ? AND s.card_mode = 'client' AND sm.role != 'guest'
  `).get(user.id));
}

// The Clients section: full base for the above, "my clients" (with a deal I can see) for salespeople.
function canSeeClients(user) {
  return canWorkWithClients(user);
}

// One client: everyone with the full base, otherwise only if one of its deals is visible to me.
function canSeeClient(user, clientId) {
  if (canSeeAllClients(user)) return true;
  if (!canWorkWithClients(user)) return false;
  return db.prepare('SELECT t.id, t.space_id, s.task_visibility FROM tasks t JOIN spaces s ON s.id = t.space_id WHERE t.client_id = ?')
    .all(clientId).some(t => canSeeTask(user, t, { id: t.space_id, task_visibility: t.task_visibility }));
}

module.exports = {
  getSpaceRole, visibleSpaces, canOpenSpace, canManageSpace, isTaskAssignee, canSeeTask, canAssign, assignableUsers,
  workspaceOfSpace, personalOwnerOf, workspaceRole, ownWorkspace, accessibleWorkspace, workspacesFor,
  canSeeClients, canSeeAllClients, canSeeClient, canWorkWithClients,
};
