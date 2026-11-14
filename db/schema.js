function initializeSchema(db) {
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT UNIQUE,
  telegram_link_code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Spaces are the primary workspace: Sales, Production, SEO, Strategy...
-- Each Space IS a board (columns = sections, cards = tasks). Visibility is
-- entirely membership-based: not a member (and not an owner) => the space
-- does not exist for you, doesn't even show in nav.
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  task_visibility TEXT NOT NULL DEFAULT 'all_members' CHECK (task_visibility IN ('all_members','assignees_and_managers')),
  -- 'client': cards represent a Client (Sales-style pipeline, quick-add
  -- creates/reuses a Client record). 'task': cards are plain work items.
  card_mode TEXT NOT NULL DEFAULT 'task' CHECK (card_mode IN ('task','client')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- role: 'manager' sees every task in the space; 'member' sees only what the
-- space's task_visibility allows; 'guest' only ever sees tasks/subtasks
-- they're personally assigned to, regardless of the space's mode.
CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager','member','guest')),
  PRIMARY KEY (space_id, user_id)
);

-- Board columns now belong to the Space (one shared board per space), not
-- to an individual Project. A Sales space's columns are its pipeline
-- stages (Новый лид, КП, ...); Production's are work stages (Backlog, ...).
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- Clients are a permanent, standalone record — never deleted when a deal
-- moves out of the active pipeline, only its stage/task changes.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  website TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  contact_telegram TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  contact_email TEXT DEFAULT '',
  potential_value TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  next_touch_at TEXT,
  hold_reason TEXT DEFAULT '',
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects are now metadata/a filter on tasks, not a mandatory navigation
-- level. "DANMAX" groups tasks across the Production board; clicking it
-- just filters the same board, it doesn't open a separate screen.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  due_date TEXT,
  due_time TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  due_notified INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- Subtasks double as "child actions" (e.g. a Sales follow-up action): they
-- can carry their own assignee + due date, and a subtask assignment shows
-- up on that person's personal dashboard just like a full task.
CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  assignee_id INTEGER REFERENCES users(id),
  due_date TEXT,
  due_time TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Client activity timeline: stage changes, contact logs, follow-ups set.
CREATE TABLE IF NOT EXISTS client_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lightweight team feed: fixed-ish set of channels, text posts with one
-- optional image, flat comments, emoji reactions. Not a Slack clone.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
CREATE INDEX IF NOT EXISTS idx_sections_space ON sections(space_id);
CREATE INDEX IF NOT EXISTS idx_projects_space ON projects(space_id);
CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space_id);
CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_client_events_client ON client_events(client_id);
CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id);

-- Task activity log (status moves, completion, due changes...). Kept apart
-- from comments so discussion and history don't crowd each other.
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
`);

// --- Lightweight additive migrations for DBs created by older versions ---
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
if (!hasColumn('tasks', 'completed_at')) db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
if (!hasColumn('subtasks', 'completed_at')) db.exec('ALTER TABLE subtasks ADD COLUMN completed_at TEXT');
if (!hasColumn('tasks', 'split_from_task_id')) db.exec('ALTER TABLE tasks ADD COLUMN split_from_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL');
// Meetings (созвоны) are tasks with kind = 'meeting': date+time, participants = assignees, a join link.
if (!hasColumn('tasks', 'kind')) db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
if (!hasColumn('tasks', 'meeting_url')) db.exec('ALTER TABLE tasks ADD COLUMN meeting_url TEXT');
if (!hasColumn('tasks', 'reminded_60')) db.exec('ALTER TABLE tasks ADD COLUMN reminded_60 INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('tasks', 'reminded_10')) db.exec('ALTER TABLE tasks ADD COLUMN reminded_10 INTEGER NOT NULL DEFAULT 0');
// Personal workspaces ("Life", "Фриланс", …): created by anyone, owned by that one person and
// invisible to everyone else — PulsAura owners included. Spaces with workspace_id NULL belong to
// the shared PulsAura workspace.
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);
`);
if (!hasColumn('spaces', 'workspace_id')) db.exec('ALTER TABLE spaces ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE');
// People the owner invited into a personal workspace (family, friends, colleagues).
db.exec(`
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
`);
if (!hasColumn('workspaces', 'invite_token')) db.exec('ALTER TABLE workspaces ADD COLUMN invite_token TEXT');
// Accounts created through a personal-workspace invite are not PulsAura staff: they never
// appear in the team (people lists, pickers, feed, clients) and can't open PulsAura.
if (!hasColumn('users', 'is_external')) db.exec('ALTER TABLE users ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0');
// Default people of a project ("account" in a content plan): a new task for that project
// gets them when nobody was picked explicitly.
db.exec(`
CREATE TABLE IF NOT EXISTS project_assignees (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
`);
// Personal order of rows on Home (drag within a day). Per viewer — it doesn't move anything for others.
db.exec(`
CREATE TABLE IF NOT EXISTS home_order (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','subtask')),
  item_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, item_id)
);
`);
// Recurring tasks: rule (daily / every2days / weekdays / weekly / monthly) + the copy spawned on completion.
if (!hasColumn('tasks', 'repeat_rule')) db.exec('ALTER TABLE tasks ADD COLUMN repeat_rule TEXT');
if (!hasColumn('tasks', 'repeat_next_id')) db.exec('ALTER TABLE tasks ADD COLUMN repeat_next_id INTEGER');
// Subtasks can have several assignees. subtasks.assignee_id stays as "the first one" for older
// code paths (imports, splitting into a card); new inserts with assignee_id are mirrored here.
db.exec(`
CREATE TABLE IF NOT EXISTS subtask_assignees (
  subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (subtask_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_subtask_assignees_user ON subtask_assignees(user_id);
CREATE TRIGGER IF NOT EXISTS trg_subtask_first_assignee AFTER INSERT ON subtasks
  WHEN NEW.assignee_id IS NOT NULL
  BEGIN INSERT OR IGNORE INTO subtask_assignees (subtask_id, user_id) VALUES (NEW.id, NEW.assignee_id); END;
INSERT OR IGNORE INTO subtask_assignees (subtask_id, user_id) SELECT id, assignee_id FROM subtasks WHERE assignee_id IS NOT NULL;
`);
// Access to the Clients section (base, contacts, notes) is granted per person by an owner.
// Sales lead segment: 'agency' | 'business' | '' (not set).
if (!hasColumn('clients', 'lead_type')) db.exec("ALTER TABLE clients ADD COLUMN lead_type TEXT NOT NULL DEFAULT ''");
if (!hasColumn('users', 'can_see_clients')) db.exec('ALTER TABLE users ADD COLUMN can_see_clients INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('subtasks', 'reminded_60')) db.exec('ALTER TABLE subtasks ADD COLUMN reminded_60 INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_section_pos ON tasks(section_id, position)');
// Imports (Asana, ...): origin id for dedup on re-import + link back to the source.
if (!hasColumn('tasks', 'source_gid')) db.exec('ALTER TABLE tasks ADD COLUMN source_gid TEXT');
if (!hasColumn('tasks', 'source_url')) db.exec('ALTER TABLE tasks ADD COLUMN source_url TEXT');
if (!hasColumn('subtasks', 'source_gid')) db.exec('ALTER TABLE subtasks ADD COLUMN source_gid TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_gid ON tasks(source_gid) WHERE source_gid IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subtasks_source_gid ON subtasks(source_gid) WHERE source_gid IS NOT NULL');

// Cold outreach system (Ваня's bot): its company_id on our client + every received event once
// (event_id), so a resent event never creates a second deal.
if (!hasColumn('clients', 'outreach_id')) db.exec('ALTER TABLE clients ADD COLUMN outreach_id TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_outreach_id ON clients(outreach_id) WHERE outreach_id IS NOT NULL');
db.exec(`
CREATE TABLE IF NOT EXISTS outreach_events (
  event_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  client_id INTEGER,
  task_id INTEGER,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('task','subtask')),
  item_id INTEGER NOT NULL,
  space_id INTEGER,
  space_name TEXT NOT NULL DEFAULT '',
  section_name TEXT NOT NULL DEFAULT '',
  parent_task_id INTEGER,
  parent_title TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash(deleted_at);
`);
// Personal workspace of the item (kept even if its space is deleted later), NULL = PulsAura.
if (!db.prepare('PRAGMA table_info(trash)').all().some(c => c.name === 'workspace_id')) db.exec('ALTER TABLE trash ADD COLUMN workspace_id INTEGER');


}

module.exports = { initializeSchema };
