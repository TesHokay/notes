const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const perms = require('../lib/permissions');
const { clientOverview, QUIET_DAYS } = require('../lib/client-overview');
const { parseLeadType } = require('../lib/view-helpers');

const router = express.Router();

// Access: owners and people granted "Клиенты: есть доступ" see the whole base; salespeople (members of
// a Sales-style space) see "my clients" — those with a deal visible to them — and work with them.
const NO_ACCESS = 'Нет доступа к этому клиенту.';
const onlyAllClients = (req, res, next) => (perms.canSeeAllClients(req.user) ? next() : res.status(403).send('Доступно владельцам и тем, кому выдан доступ ко всей базе клиентов.'));
const clientsSection = (req, res, next) => (perms.canSeeClients(req.user) ? next() : res.status(403).send('Нет доступа к клиентам. Попросите владельца выдать доступ в разделе «Команда».'));
const oneClient = (req, res, next) => (perms.canSeeClient(req.user, Number(req.params.id)) ? next()
  : (req.method === 'GET' ? res.status(403).send(NO_ACCESS) : res.status(403).json({ error: 'forbidden' })));
const salesWork = (req, res, next) => (perms.canWorkWithClients(req.user) ? next() : res.status(403).json({ error: 'forbidden' }));
router.get('/search', salesWork);
router.post('/:id(\\d+)/delete', onlyAllClients);
router.post('/:id(\\d+)', salesWork, oneClient);
router.post('/:id(\\d+)/:action', salesWork, oneClient);
router.get('/', clientsSection);
router.post('/', onlyAllClients);
router.get('/:id(\\d+)', clientsSection, oneClient);

function presetToDate(preset, customDate, customTime) {
  const days = { '1w': 7, '2w': 14, '1m': 30, '3m': 90 }[preset];
  if (days) return { date: dates.addDays(dates.localDate(), days), time: null };
  if (preset === 'custom' && customDate) return { date: customDate, time: customTime || null };
  return { date: null, time: null };
}

router.get('/', (req, res) => {
  const fullBase = perms.canSeeAllClients(req.user);
  // Salespeople: only clients with a deal in their pipeline(s).
  let all = clientOverview(req.user).filter(r => fullBase || r.dealCount > 0);
  const leadType = ['agency', 'business', 'none'].includes(req.query.type) ? req.query.type : '';
  const typeCounts = {
    agency: all.filter(r => r.client.lead_type === 'agency').length,
    business: all.filter(r => r.client.lead_type === 'business').length,
    none: all.filter(r => !r.client.lead_type).length,
  };
  if (leadType) all = all.filter(r => (r.client.lead_type || 'none') === leadType);
  const filter = ['active', 'quiet', 'idle'].includes(req.query.f) ? req.query.f : 'all';
  const counts = {
    all: all.length,
    active: all.filter(r => r.activeDeal).length,
    quiet: all.filter(r => r.quiet).length,
    idle: all.filter(r => !r.activeDeal).length,
  };
  const rows = all.filter(r => filter === 'all' || (filter === 'active' && r.activeDeal) || (filter === 'quiet' && r.quiet) || (filter === 'idle' && !r.activeDeal));
  // Quiet ones first, then active by nearest next step, then the rest by name.
  const nextKey = r => (r.next && r.next.due_date ? r.next.due_date + (r.next.due_time || '99:99') : '9999');
  rows.sort((a, b) => (b.quiet - a.quiet) || (b.activeDeal - a.activeDeal) || nextKey(a).localeCompare(nextKey(b))
    || a.client.name.localeCompare(b.client.name, 'ru'));
  res.render('clients', { rows, filter, counts, leadType, typeCounts, fullBase, quietDays: QUIET_DAYS, activeNav: 'clients', title: fullBase ? 'Клиенты' : 'Мои клиенты' });
});

router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/clients');
  const info = db.prepare(`
    INSERT INTO clients (name, website, contact_name, contact_telegram, contact_phone, contact_email, potential_value, notes, lead_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    (req.body.website || '').trim(),
    (req.body.contact_name || '').trim(),
    (req.body.contact_telegram || '').trim(),
    (req.body.contact_phone || '').trim(),
    (req.body.contact_email || '').trim(),
    (req.body.potential_value || '').trim(),
    (req.body.notes || '').trim(),
    parseLeadType(req.body.lead_type)
  );
  db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'created', 'Клиент создан')").run(info.lastInsertRowid, req.user.id);
  res.redirect('/clients');
});

router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const rows = process.env.CRM_CLOUDFLARE && Buffer.byteLength(`%${q}%`)>50
    ? db.prepare('SELECT id, name FROM clients WHERE instr(lower(name),lower(?)) > 0 ORDER BY name LIMIT 40').all(q)
    : db.prepare('SELECT id, name FROM clients WHERE name LIKE ? ORDER BY name LIMIT 40').all(`%${q}%`);
  res.json(rows.filter(c => perms.canSeeClient(req.user, c.id)).slice(0, 8));
});

router.get('/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Клиент не найден');

  // Only cards this person may see anyway (space membership / visibility rules).
  const tasks = db.prepare(`
    SELECT t.*, s.name AS section_name, sp.name AS space_name, sp.id AS space_id, sp.task_visibility
    FROM tasks t JOIN sections s ON s.id = t.section_id JOIN spaces sp ON sp.id = t.space_id
    WHERE t.client_id = ? ORDER BY t.created_at DESC
  `).all(client.id).filter(t => perms.canSeeTask(req.user, t, { id: t.space_id, task_visibility: t.task_visibility }));

  const subs = tasks.length ? db.prepare(`SELECT * FROM subtasks WHERE task_id IN (${tasks.map(() => '?').join(',')}) ORDER BY done ASC, position ASC`).all(...tasks.map(t => t.id)) : [];
  tasks.forEach(t => { t.subtasks = subs.filter(s => s.task_id === t.id); });

  const events = db.prepare(`
    SELECT ce.*, u.name AS author_name FROM client_events ce
    LEFT JOIN users u ON u.id = ce.user_id
    WHERE ce.client_id = ? ORDER BY ce.created_at DESC
  `).all(client.id);

  res.render('client', { salesClient: client, tasks, events, fullBase: perms.canSeeAllClients(req.user), activeNav: 'clients', title: client.name });
});

// Delete a client from the base. Their Sales cards stay (just no longer linked); history goes.
router.post('/:id(\\d+)/delete', onlyAllClients, async (req, res, next) => {
  try {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/clients');
  await require('../lib/backup').makeBackup(db, db.filePath, `before-delete-client-${client.id}`);
  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  res.redirect('/clients');
  } catch (err) { next(err); }
});

router.post('/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Клиент не найден');

  db.prepare(`
    UPDATE clients SET name = ?, website = ?, contact_name = ?, contact_telegram = ?, contact_phone = ?, contact_email = ?, potential_value = ?, notes = ?, lead_type = ?
    WHERE id = ?
  `).run(
    (req.body.name || client.name).trim(),
    (req.body.website || '').trim(),
    (req.body.contact_name || '').trim(),
    (req.body.contact_telegram || '').trim(),
    (req.body.contact_phone || '').trim(),
    (req.body.contact_email || '').trim(),
    (req.body.potential_value || '').trim(),
    (req.body.notes || '').trim(),
    req.body.lead_type === undefined ? client.lead_type : parseLeadType(req.body.lead_type),
    client.id
  );
  res.redirect(`/clients/${client.id}`);
});

// Drawer toggle «Агентство / Бизнес».
router.post('/:id/lead-type', (req, res) => {
  const type = parseLeadType(req.body.type);
  const info = db.prepare('UPDATE clients SET lead_type = ? WHERE id = ?').run(type, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, type });
});

router.post('/:id/follow-up', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'not_found' });

  const { date, time } = presetToDate(req.body.preset, req.body.custom_date, req.body.custom_time);
  db.prepare('UPDATE clients SET next_touch_at = ?, hold_reason = \'\' WHERE id = ?').run(date, client.id);
  db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'follow_up_set', ?)")
    .run(client.id, req.user.id, `Напомнить: ${date}${time ? ' ' + time : ''}`);

  res.json({ ok: true, next_touch_at: date });
});

router.post('/:id/hold', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'not_found' });

  const { date } = presetToDate(req.body.preset, req.body.custom_date, req.body.custom_time);
  const reason = (req.body.reason || '').trim();
  db.prepare('UPDATE clients SET next_touch_at = ?, hold_reason = ? WHERE id = ?').run(date, reason, client.id);
  db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'hold', ?)")
    .run(client.id, req.user.id, `На hold до ${date}${reason ? ': ' + reason : ''}`);

  res.json({ ok: true, next_touch_at: date });
});

router.post('/:id/log-contact', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'not_found' });

  const summary = (req.body.summary || '').trim();
  const outcome = (req.body.outcome || '').trim();
  const nextAction = (req.body.next_action || '').trim();
  const nextDate = req.body.next_date || null;
  const nextTime = req.body.next_time || null;

  db.prepare("UPDATE clients SET last_activity_at = datetime('now'), next_touch_at = COALESCE(?, next_touch_at) WHERE id = ?")
    .run(nextDate, client.id);

  const body = [summary, outcome ? `Итог: ${outcome}` : '', nextAction ? `Далее: ${nextAction}` : '']
    .filter(Boolean).join('\n');
  db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'contact_log', ?)")
    .run(client.id, req.user.id, body);

  if (nextAction && nextDate) {
    const requested = req.body.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ? AND client_id = ?').get(Number(req.body.task_id), client.id) : null;
    const pipelineTask = requested || db.prepare('SELECT * FROM tasks WHERE client_id = ? ORDER BY created_at DESC LIMIT 1').get(client.id);
    if (pipelineTask) {
      const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM subtasks WHERE task_id = ?').get(pipelineTask.id).m;
      db.prepare('INSERT INTO subtasks (task_id, title, assignee_id, due_date, due_time, position) VALUES (?, ?, ?, ?, ?, ?)')
        .run(pipelineTask.id, nextAction, req.user.id, nextDate, nextTime, maxPos + 1);
    }
  }

  res.json({ ok: true });
});

module.exports = router;
