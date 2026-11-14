// Recurring tasks. A task with repeat_rule, when completed, spawns its next occurrence: a copy in
// the same column with the date moved forward, same people, subtasks reset to "not done".
// The completed one stays in history. tasks.repeat_next_id guards against double spawning
// (complete → reopen → complete again).
const db = require('../db');
const dates = require('./dates');

const RULES = {
  daily: 'Каждый день',
  every2days: 'Через день',
  weekdays: 'По будням (пн–пт)',
  weekly: 'Каждую неделю',
  monthly: 'Каждый месяц',
};

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate(); // 31 Jan + 1 month → 28/29 Feb
  return dates.localDate(new Date(y, m - 1 + n, Math.min(d, last)));
}

function step(rule, dateStr) {
  switch (rule) {
    case 'daily': return dates.addDays(dateStr, 1);
    case 'every2days': return dates.addDays(dateStr, 2);
    case 'weekly': return dates.addDays(dateStr, 7);
    case 'monthly': return addMonths(dateStr, 1);
    case 'weekdays': {
      let next = dates.addDays(dateStr, 1);
      while ([0, 6].includes(new Date(`${next}T12:00:00`).getDay())) next = dates.addDays(next, 1);
      return next;
    }
    default: return null;
  }
}

// Next date after `from` (the task's own date, or today if it had none) that is later than today —
// completing an overdue daily task doesn't pile up copies in the past.
function nextDate(rule, from, today = dates.localDate()) {
  let next = step(rule, from || today);
  for (let i = 0; next && next <= today && i < 400; i++) next = step(rule, next);
  return next;
}

const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

function spawnNext(task, userId) {
  if (!RULES[task.repeat_rule]) return null;
  if (task.repeat_next_id && db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(task.repeat_next_id)) return null;
  const { logTaskEvent } = require('./task-service');

  const due = nextDate(task.repeat_rule, task.due_date);
  const shift = task.due_date ? daysBetween(task.due_date, due) : 0;
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM tasks WHERE section_id = ?').get(task.section_id).m;
  const newId = db.prepare(`
    INSERT INTO tasks (space_id, section_id, project_id, client_id, title, description, priority, due_date, due_time,
                       created_by, position, kind, meeting_url, repeat_rule)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.space_id, task.section_id, task.project_id, task.client_id, task.title, task.description || '', task.priority,
    due, task.due_date ? task.due_time : null, userId || task.created_by, position, task.kind || 'task', task.meeting_url || null,
    task.repeat_rule).lastInsertRowid;

  db.prepare('INSERT INTO task_assignees (task_id, user_id) SELECT ?, user_id FROM task_assignees WHERE task_id = ?').run(newId, task.id);
  db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position, id').all(task.id).forEach(s => {
    const sDue = s.due_date && task.due_date ? dates.addDays(s.due_date, shift) : null;
    const sid = db.prepare('INSERT INTO subtasks (task_id, title, due_date, due_time, position) VALUES (?, ?, ?, ?, ?)')
      .run(newId, s.title, sDue, sDue ? s.due_time : null, s.position).lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO subtask_assignees (subtask_id, user_id) SELECT ?, user_id FROM subtask_assignees WHERE subtask_id = ?').run(sid, s.id);
    const first = db.prepare('SELECT user_id FROM subtask_assignees WHERE subtask_id = ? ORDER BY rowid LIMIT 1').get(sid);
    if (first) db.prepare('UPDATE subtasks SET assignee_id = ? WHERE id = ?').run(first.user_id, sid);
  });

  db.prepare('UPDATE tasks SET repeat_next_id = ? WHERE id = ?').run(newId, task.id);
  logTaskEvent(newId, userId, 'created', `Повтор (${RULES[task.repeat_rule].toLowerCase()}) — следующая после выполненной`);
  logTaskEvent(task.id, userId, 'repeat', `Создана следующая: ${dates.dueInfo(due, null).full}`);
  return newId;
}

module.exports = { RULES, nextDate, spawnNext };
