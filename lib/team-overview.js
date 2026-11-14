// Team-wide picture for PulsAura owners: every open task and subtask in PulsAura spaces with its
// people and due state. Feeds the Home counters and the /overview page, so both always agree.
const db = require('../db');
const dates = require('./dates');
const { attachSubtaskPeople } = require('./task-service');
const { dealTitle } = require('./view-helpers');

function loadTeamItems() {
  const tasks = db.prepare(`
    SELECT t.id, t.id AS link_id, 0 AS is_subtask, t.title, t.kind, t.due_date, t.due_time, t.priority,
      s.name AS space_name, s.card_mode, c.name AS client_name
    FROM tasks t JOIN spaces s ON s.id = t.space_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.done = 0 AND s.workspace_id IS NULL
  `).all();
  if (tasks.length) {
    const byTask = {};
    const ph = tasks.map(() => '?').join(',');
    db.prepare(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id IN (${ph}) ORDER BY u.name`)
      .all(...tasks.map(t => t.id)).forEach(r => (byTask[r.task_id] ||= []).push({ id: r.id, name: r.name }));
    tasks.forEach(t => {
      t.people = byTask[t.id] || [];
      if (t.card_mode === 'client') t.title = dealTitle(t.client_name, t.title);
    });
  }
  const subtasks = attachSubtaskPeople(db.prepare(`
    SELECT sub.id, t.id AS link_id, 1 AS is_subtask, sub.title, 'task' AS kind, sub.due_date, sub.due_time, 'medium' AS priority,
      s.name AS space_name, s.card_mode, t.title AS parent_title, c.name AS client_name
    FROM subtasks sub JOIN tasks t ON t.id = sub.task_id JOIN spaces s ON s.id = t.space_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE sub.done = 0 AND t.done = 0 AND s.workspace_id IS NULL
  `).all());
  subtasks.forEach(s => { if (s.card_mode === 'client') s.parent_title = dealTitle(s.client_name, s.parent_title); });
  // A card whose open subtasks already have people isn't "abandoned", even with nobody on the card itself.
  const staffedCards = new Set(subtasks.filter(s => s.people.length).map(s => s.link_id));
  tasks.forEach(t => { t.unassigned = !t.people.length && !staffedCards.has(t.id); });

  const today = dates.localDate();
  return [...tasks, ...subtasks].map(it => {
    const due = dates.dueInfo(it.due_date, it.due_time);
    return {
      ...it,
      where: [it.space_name, it.parent_title].filter(Boolean).join(' · '),
      bucket: !it.due_date ? 'none' : due.state === 'overdue' ? 'overdue' : it.due_date === today ? 'today'
        : it.due_date <= dates.addDays(today, 7) ? 'week' : 'later',
    };
  }).sort((a, b) => ((a.due_date || '9999') + (a.due_time || '99')).localeCompare((b.due_date || '9999') + (b.due_time || '99')));
}

// "Без исполнителя" = open cards with nobody on them AND nobody on any of their open subtasks.
const isUnassigned = i => !i.is_subtask && i.unassigned;

// Counters for the Home header.
function teamCounts(items = loadTeamItems()) {
  return {
    todayCount: items.filter(i => i.bucket === 'today').length,
    overdueCount: items.filter(i => i.bucket === 'overdue').length,
    unassignedCount: items.filter(isUnassigned).length,
  };
}

// Per person: their open items split by bucket; PulsAura staff only, most overdue first.
function perPerson(items = loadTeamItems()) {
  const people = db.prepare('SELECT id, name FROM users WHERE is_external = 0 ORDER BY name').all();
  return people.map(p => {
    const mine = items.filter(i => i.people.some(x => x.id === p.id));
    const by = k => mine.filter(i => i.bucket === k);
    return { ...p, total: mine.length, overdue: by('overdue'), today: by('today'), week: by('week'), later: by('later'), none: by('none') };
  }).sort((a, b) => b.overdue.length - a.overdue.length || b.today.length - a.today.length || b.total - a.total || a.name.localeCompare(b.name, 'ru'));
}

// Completed in PulsAura over the last `days` days (tasks + subtasks), newest first, with people
// and — for cards — who ticked it off (from the activity log).
function loadTeamDone(days = 7) {
  const since = `-${Math.max(1, Math.min(365, Number(days) || 7))} days`;
  const tasks = db.prepare(`
    SELECT t.id, t.id AS link_id, 0 AS is_subtask, t.title, t.kind, t.completed_at, s.name AS space_name, s.card_mode, c.name AS client_name,
      (SELECT u.name FROM task_events e JOIN users u ON u.id = e.user_id WHERE e.task_id = t.id AND e.type = 'completed' ORDER BY e.id DESC LIMIT 1) AS closed_by
    FROM tasks t JOIN spaces s ON s.id = t.space_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.done = 1 AND s.workspace_id IS NULL AND t.completed_at >= datetime('now', ?)
  `).all(since);
  if (tasks.length) {
    const byTask = {};
    const ph = tasks.map(() => '?').join(',');
    db.prepare(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id IN (${ph}) ORDER BY u.name`)
      .all(...tasks.map(t => t.id)).forEach(r => (byTask[r.task_id] ||= []).push({ id: r.id, name: r.name }));
    tasks.forEach(t => {
      t.people = byTask[t.id] || [];
      if (t.card_mode === 'client') t.title = dealTitle(t.client_name, t.title);
    });
  }
  const subtasks = attachSubtaskPeople(db.prepare(`
    SELECT sub.id, t.id AS link_id, 1 AS is_subtask, sub.title, 'task' AS kind, sub.completed_at, s.name AS space_name, s.card_mode,
      t.title AS parent_title, c.name AS client_name, NULL AS closed_by
    FROM subtasks sub JOIN tasks t ON t.id = sub.task_id JOIN spaces s ON s.id = t.space_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE sub.done = 1 AND s.workspace_id IS NULL AND sub.completed_at >= datetime('now', ?)
  `).all(since));
  subtasks.forEach(s => { if (s.card_mode === 'client') s.parent_title = dealTitle(s.client_name, s.parent_title); });
  return [...tasks, ...subtasks]
    .map(it => ({ ...it, where: [it.space_name, it.parent_title].filter(Boolean).join(' · ') }))
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
}

// "Who did how much": completed items per person (an item with several people counts for each).
function doneByPerson(items) {
  const map = new Map();
  items.forEach(it => it.people.forEach(p => {
    const cur = map.get(p.id) || { id: p.id, name: p.name, n: 0 };
    cur.n++;
    map.set(p.id, cur);
  }));
  return [...map.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ru'));
}

module.exports = { loadTeamItems, teamCounts, perPerson, isUnassigned, loadTeamDone, doneByPerson };
