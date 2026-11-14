// Client base overview: for every client — current Sales stage, next action, responsible people,
// open work, last activity, and whether the client has gone quiet (open deal, nothing happening
// for QUIET_DAYS, no future follow-up planned). Used by the Clients page and the owners' digest.
const db = require('../db');
const dates = require('./dates');
const perms = require('./permissions');

const QUIET_DAYS = Number(process.env.CLIENT_QUIET_DAYS || 14);
// Columns meaning the deal is over — such clients are never "quiet".
const CLOSED_STAGE = /неактуал|бывш|проигр|отказ|lost/i;

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> Date
const utc = s => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);

function clientOverview(user) {
  const clients = db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.client_id, t.space_id, t.section_id, t.done, t.due_date, t.due_time, t.created_at, t.updated_at,
      sec.name AS section_name, sec.position AS section_pos, sp.name AS space_name, sp.icon AS space_icon, sp.card_mode, sp.task_visibility
    FROM tasks t JOIN sections sec ON sec.id = t.section_id JOIN spaces sp ON sp.id = t.space_id
    WHERE t.client_id IS NOT NULL AND sp.workspace_id IS NULL
  `).all().filter(t => !user || perms.canSeeTask(user, t, { id: t.space_id, task_visibility: t.task_visibility }));

  const ids = tasks.map(t => t.id);
  const inList = ids.length ? `(${ids.join(',')})` : '(NULL)';
  const subtasks = require('./task-service').attachSubtaskPeople(db.prepare(`SELECT s.* FROM subtasks s WHERE s.task_id IN ${inList}`).all());
  const assignees = db.prepare(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id IN ${inList}`).all();
  const taskActivity = Object.fromEntries(db.prepare(`
    SELECT task_id, MAX(created_at) AS at FROM (
      SELECT task_id, created_at FROM task_events WHERE task_id IN ${inList} AND body NOT LIKE 'Импортировано из Asana%'
      UNION ALL SELECT task_id, created_at FROM comments WHERE task_id IN ${inList}
      UNION ALL SELECT task_id, completed_at FROM subtasks WHERE task_id IN ${inList} AND completed_at IS NOT NULL
    ) GROUP BY task_id
  `).all().map(r => [r.task_id, r.at]));
  const clientEvents = Object.fromEntries(db.prepare('SELECT client_id, MAX(created_at) AS at FROM client_events WHERE body != ? GROUP BY client_id').all('Клиент создан при импорте из Asana').map(r => [r.client_id, r.at]));

  const today = dates.localDate();
  const now = Date.now();

  return clients.map(c => {
    const deals = tasks.filter(t => t.client_id === c.id);
    const open = deals.filter(t => !t.done);
    const openIds = new Set(open.map(t => t.id));
    const openSubs = subtasks.filter(s => openIds.has(s.task_id) && !s.done);

    // Stage: the open Sales-style card that is furthest along the pipeline.
    const stageDeal = open.filter(t => t.card_mode === 'client').sort((a, b) => b.section_pos - a.section_pos)[0] || open[0] || null;

    // Next action: nearest dated open subtask, else nearest dated open card, else any open subtask.
    const key = x => (x.due_date || '9999-99-99') + (x.due_time || '99:99');
    const dated = [...openSubs.map(s => ({ ...s, kind: 'subtask', link: s.task_id })), ...open.filter(t => t.due_date).map(t => ({ ...t, kind: 'task', link: t.id }))]
      .sort((a, b) => key(a).localeCompare(key(b)));
    const next = dated[0] || null;

    const people = new Map();
    assignees.filter(a => openIds.has(a.task_id)).forEach(a => people.set(a.id, a.name));
    openSubs.forEach(s => s.people.forEach(p => people.set(p.id, p.name)));

    // created_at is left out on purpose: imported cards carry their original Asana dates in updated_at.
    const stamps = [c.last_activity_at, clientEvents[c.id], ...deals.flatMap(t => [t.updated_at, taskActivity[t.id]])]
      .filter(Boolean).map(utc).filter(d => !Number.isNaN(d.getTime()));
    const lastActivity = stamps.length ? new Date(Math.max(...stamps)) : null;
    const idleDays = lastActivity ? Math.floor((now - lastActivity) / 86400000) : null;

    const activeDeal = open.some(t => !CLOSED_STAGE.test(t.section_name));
    const plannedTouch = c.next_touch_at && c.next_touch_at.slice(0, 10) >= today;
    const plannedAction = next && next.due_date && next.due_date >= today;
    const quiet = activeDeal && idleDays !== null && idleDays >= QUIET_DAYS && !plannedTouch && !plannedAction;

    return {
      client: c,
      stage: stageDeal ? { name: stageDeal.section_name, space: stageDeal.space_name, icon: stageDeal.space_icon, taskId: stageDeal.id } : null,
      next,
      people: [...people].map(([id, name]) => ({ id, name })),
      openCount: open.length + openSubs.length,
      dealCount: deals.length,
      activeDeal,
      lastActivity,
      idleDays,
      quiet,
    };
  });
}

module.exports = { clientOverview, QUIET_DAYS };
