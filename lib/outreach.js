// Intake from the cold outreach system (Ваня's mailing bot). Only warm leads come in: the company
// replied, a call was booked / moved / held, a deal, a refusal. Each company becomes a client with a
// card in the «Холодные касания» pipeline; the card moves by stage, the owner (Ваня / Юля) is assigned.
// Idempotent: event_id is stored, and the company is matched by our clients.outreach_id = company_id.
const crypto = require('node:crypto');
const db = require('../db');
const taskService = require('./task-service');
const telegram = require('./telegram');

const SPACE_NAME = 'Холодные касания';
const STAGES = ['Ответили', 'Созвон назначен', 'Созвон прошёл', 'Сделка', 'Отказ / не беспокоить'];
// event → stage index in STAGES
const EVENTS = {
  replied: 0,
  call_scheduled: 1,
  call_rescheduled: 1,
  call_done: 2,
  deal: 3,
  refused: 4,
  do_not_contact: 4,
};
const EVENT_LABELS = {
  replied: 'Компания ответила на рассылку',
  call_scheduled: 'Назначен созвон',
  call_rescheduled: 'Созвон перенесён',
  call_done: 'Созвон прошёл',
  deal: 'Сделка',
  refused: 'Отказ',
  do_not_contact: 'Просили не беспокоить',
};
const CALL_TITLE = '📞 Созвон';

class InputError extends Error {}

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

// The pipeline: OUTREACH_SPACE_ID, or the PulsAura space «Холодные касания», created on first use.
function pipeline() {
  let space = process.env.OUTREACH_SPACE_ID
    ? db.prepare('SELECT * FROM spaces WHERE id = ?').get(Number(process.env.OUTREACH_SPACE_ID))
    : db.prepare("SELECT * FROM spaces WHERE name = ? AND workspace_id IS NULL AND card_mode = 'client' ORDER BY id LIMIT 1").get(SPACE_NAME);
  if (!space) {
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM spaces WHERE workspace_id IS NULL').get().m;
    const id = db.prepare("INSERT INTO spaces (name, icon, position, task_visibility, card_mode) VALUES (?, '📨', ?, 'all_members', 'client')")
      .run(SPACE_NAME, pos).lastInsertRowid;
    STAGES.forEach((n, i) => db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)').run(id, n, i));
    space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
  }
  const sections = db.prepare('SELECT * FROM sections WHERE space_id = ? ORDER BY position').all(space.id);
  // Stage by name; a renamed / missing column falls back to the column at the same position.
  const stage = i => sections.find(s => s.name.toLocaleLowerCase('ru') === STAGES[i].toLocaleLowerCase('ru'))
    || sections[Math.min(i, sections.length - 1)];
  return { space, sections, stage };
}

// "Ваня", "vanya", "ivan@…" → CRM user. Matches email, then name, then first word of the name.
const OWNER_ALIASES = { vanya: 'ваня', vanja: 'ваня', ivan: 'иван', yulia: 'юля', julia: 'юля', yulya: 'юля', julya: 'юля' };
function findOwner(owner) {
  const o = str(owner, 100);
  if (!o) return null;
  const byEmail = db.prepare('SELECT id, name FROM users WHERE lower(email) = lower(?) AND is_external = 0').get(o);
  if (byEmail) return byEmail;
  const key = (OWNER_ALIASES[o.toLowerCase()] || o).toLocaleLowerCase('ru');
  const people = db.prepare('SELECT id, name FROM users WHERE is_external = 0 ORDER BY id').all();
  return people.find(p => p.name.toLocaleLowerCase('ru') === key)
    || people.find(p => p.name.toLocaleLowerCase('ru').startsWith(key + ' ')) || null;
}

// ISO time with offset (2026-10-30T15:00:00+03:00) → team-local date + time.
function localDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dates = require('./dates');
  return { date: dates.localDate(d), time: dates.localTime(d) };
}

function validate(body) {
  if (!body || typeof body !== 'object') throw new InputError('body_must_be_json');
  const companyId = str(body.company_id, 100);
  if (!companyId) throw new InputError('company_id_required');
  const event = str(body.event, 40);
  if (!(event in EVENTS)) throw new InputError(`unknown_event: use ${Object.keys(EVENTS).join(', ')}`);
  const company = body.company || {};
  const name = str(company.name, 200);
  if (!name) throw new InputError('company.name_required');
  let call = null;
  if (event === 'call_scheduled' || event === 'call_rescheduled') {
    call = localDateTime(body.call_at);
    if (!call) throw new InputError('call_at_required: ISO 8601 with offset, e.g. 2026-10-30T15:00:00+03:00');
  }
  const eventId = str(body.event_id, 200)
    || crypto.createHash('sha1').update(JSON.stringify([companyId, event, body.call_at || '', body.occurred_at || ''])).digest('hex');
  return { eventId, companyId, event, name, company, call };
}

function handleEvent(body) {
  const v = validate(body);
  const seen = db.prepare('SELECT client_id, task_id FROM outreach_events WHERE event_id = ?').get(v.eventId);
  if (seen) return { ok: true, duplicate: true, client_id: seen.client_id, task_id: seen.task_id };

  const contact = body.contact || {};
  const warnings = [];
  const owner = findOwner(body.owner);
  if (body.owner && !owner) warnings.push(`owner «${str(body.owner, 100)}» not found in CRM — card left unassigned`);
  const { space, stage } = pipeline();
  const target = stage(EVENTS[v.event]);
  const replyText = str(body.reply_text, 4000);
  const notify = [];

  const result = taskService.transaction(() => {
    // Client: by our company_id, else by name in this pipeline (then remember the company_id).
    let client = db.prepare('SELECT * FROM clients WHERE outreach_id = ?').get(v.companyId)
      || taskService.findClientForSpace(v.name, space.id);
    if (!client) {
      const id = db.prepare('INSERT INTO clients (name, outreach_id) VALUES (?, ?)').run(v.name, v.companyId).lastInsertRowid;
      db.prepare("INSERT INTO client_events (client_id, type, body) VALUES (?, 'created', 'Клиент пришёл из рассылки')").run(id);
      client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    } else if (!client.outreach_id) {
      db.prepare('UPDATE clients SET outreach_id = ? WHERE id = ?').run(v.companyId, client.id);
    }
    // Contacts: fill only what's empty, never overwrite what the team typed.
    const fill = { website: str(v.company.website, 300), contact_email: str(contact.email, 200), contact_phone: str(contact.phone, 50),
      contact_telegram: str(contact.telegram, 100), contact_name: str(contact.name, 200) };
    Object.entries(fill).forEach(([k, val]) => { if (val && !client[k]) db.prepare(`UPDATE clients SET ${k} = ? WHERE id = ?`).run(val, client.id); });

    // Card in the pipeline.
    let task = db.prepare('SELECT * FROM tasks WHERE client_id = ? AND space_id = ? ORDER BY done ASC, id DESC LIMIT 1').get(client.id, space.id);
    if (!task) {
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM tasks WHERE section_id = ?').get(target.id).m;
      const id = db.prepare('INSERT INTO tasks (space_id, section_id, client_id, title, position) VALUES (?, ?, ?, ?, ?)')
        .run(space.id, target.id, client.id, v.name, pos).lastInsertRowid;
      taskService.logTaskEvent(id, null, 'created', `Из рассылки: ${EVENT_LABELS[v.event]}`);
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    } else {
      if (task.done) { taskService.setTaskDone(task, false, null); task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id); }
      const cur = db.prepare('SELECT position FROM sections WHERE id = ?').get(task.section_id);
      // A late «replied» never pulls a card back from a later stage; everything else moves it.
      if (task.section_id !== target.id && !(v.event === 'replied' && cur && cur.position > target.position)) {
        task = taskService.moveTask({ task, sectionId: target.id, userId: null });
      }
      taskService.logTaskEvent(task.id, null, 'outreach', `Рассылка: ${EVENT_LABELS[v.event]}`);
    }

    if (owner) {
      const added = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(task.id, owner.id).changes;
      db.prepare("INSERT OR IGNORE INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')").run(space.id, owner.id);
      if (added || v.event === 'replied') notify.push(owner.id);
    }

    // Call: one open «📞 Созвон» subtask — created, or moved on reschedule; closed when the call happened.
    if (v.call) {
      const sub = db.prepare('SELECT * FROM subtasks WHERE task_id = ? AND done = 0 AND title LIKE ? ORDER BY id DESC LIMIT 1').get(task.id, `${CALL_TITLE}%`);
      if (sub) {
        db.prepare('UPDATE subtasks SET due_date = ?, due_time = ?, reminded_60 = 0 WHERE id = ?').run(v.call.date, v.call.time, sub.id);
      } else {
        const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM subtasks WHERE task_id = ?').get(task.id).m;
        const sid = db.prepare('INSERT INTO subtasks (task_id, title, due_date, due_time, position, done) VALUES (?, ?, ?, ?, ?, 0)')
          .run(task.id, `${CALL_TITLE} с ${v.name}`, v.call.date, v.call.time, pos).lastInsertRowid;
        if (owner) taskService.setSubtaskAssignees(sid, [owner.id]);
      }
      db.prepare("UPDATE clients SET next_touch_at = ?, hold_reason = '' WHERE id = ?").run(v.call.date, client.id);
      if (owner && !notify.includes(owner.id)) notify.push(owner.id);
    }
    if (v.event === 'call_done' || v.event === 'deal' || v.event === 'refused' || v.event === 'do_not_contact') {
      db.prepare("UPDATE subtasks SET done = 1, completed_at = datetime('now') WHERE task_id = ? AND done = 0 AND title LIKE ?").run(task.id, `${CALL_TITLE}%`);
    }
    if (v.event === 'refused' || v.event === 'do_not_contact') {
      db.prepare('UPDATE clients SET next_touch_at = NULL, hold_reason = ? WHERE id = ?').run(EVENT_LABELS[v.event], client.id);
    }

    const ownerNote = owner ? ` · ведёт ${owner.name}` : '';
    const callNote = v.call ? ` · ${v.call.date.split('-').reverse().join('.')} ${v.call.time}` : '';
    db.prepare("INSERT INTO client_events (client_id, type, body) VALUES (?, 'outreach', ?)")
      .run(client.id, `📨 ${EVENT_LABELS[v.event]}${callNote}${ownerNote}${replyText ? `\n«${replyText}»` : ''}`);
    db.prepare("UPDATE clients SET last_activity_at = datetime('now') WHERE id = ?").run(client.id);
    db.prepare('INSERT INTO outreach_events (event_id, company_id, event, payload, client_id, task_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.eventId, v.companyId, v.event, JSON.stringify(body).slice(0, 20000), client.id, task.id);
    return { client_id: client.id, task_id: task.id };
  });

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.task_id);
  notify.forEach(uid => telegram.notifyAssigned(uid, { ...task, title: `${v.name}: ${EVENT_LABELS[v.event]}` }, space.name, 'Рассылка'));
  return { ok: true, duplicate: false, ...result, stage: target.name, warnings };
}

module.exports = { handleEvent, InputError, STAGES, EVENTS, findOwner, localDateTime };
