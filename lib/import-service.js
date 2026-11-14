// Bulk import of Sales clients from Excel (.xlsx) or CSV.
// Flow: parse → plan (preview, nothing written) → apply (one transaction).
// Re-importing the same file is safe: clients are matched by name, actions
// are not duplicated, fields are only overwritten by non-empty values.
const db = require('../db');
const dates = require('./dates');
const taskService = require('./task-service');
const { parseLeadType } = require('./view-helpers');

// Header aliases → field. Matching is case/space-insensitive.
const COLUMNS = [
  { key: 'name', title: 'Клиент', aliases: ['клиент', 'компания', 'название', 'client', 'company', 'name'], required: true },
  { key: 'lead_type', title: 'Тип (агентство / бизнес)', aliases: ['тип', 'тип лида', 'тип клиента', 'сегмент', 'категория', 'type', 'segment'] },
  { key: 'stage', title: 'Этап', aliases: ['этап', 'статус', 'стадия', 'stage', 'status'] },
  { key: 'contact_name', title: 'Контактное лицо', aliases: ['контактное лицо', 'контакт', 'лпр', 'contact', 'contact name'] },
  { key: 'contact_telegram', title: 'Telegram', aliases: ['telegram', 'телеграм', 'tg', 'тг'] },
  { key: 'contact_phone', title: 'Телефон', aliases: ['телефон', 'phone', 'тел'] },
  { key: 'contact_email', title: 'Email', aliases: ['email', 'e-mail', 'почта', 'mail'] },
  { key: 'website', title: 'Сайт', aliases: ['сайт', 'website', 'site', 'url'] },
  { key: 'potential_value', title: 'Потенциал', aliases: ['потенциал', 'бюджет', 'сумма', 'potential', 'value'] },
  { key: 'owner', title: 'Ответственный', aliases: ['ответственный', 'менеджер', 'исполнитель', 'owner', 'manager'] },
  { key: 'next_action', title: 'Следующее действие', aliases: ['следующее действие', 'действие', 'задача', 'next action', 'next step', 'следующий шаг'] },
  { key: 'action_date', title: 'Срок действия', aliases: ['срок действия', 'срок', 'дата действия', 'due', 'due date'] },
  { key: 'action_time', title: 'Время', aliases: ['время', 'время действия', 'time'] },
  { key: 'next_touch', title: 'Следующий контакт', aliases: ['следующий контакт', 'дата контакта', 'follow-up', 'follow up', 'next contact', 'напомнить'] },
  { key: 'contact_result', title: 'Итог контакта', aliases: ['итог контакта', 'итог', 'результат', 'комментарий', 'что было', 'result', 'comment'] },
  { key: 'notes', title: 'Заметки', aliases: ['заметки', 'примечание', 'notes', 'note'] },
];

const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[*:]$/, '').trim();

// ---------- Parsing ----------

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function decodeText(buf) {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1251').decode(buf); // Excel "CSV (разделители — точка с запятой)"
  return text.replace(/^﻿/, '');
}

async function readRows(buffer, filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return [parseCsv(decodeText(buffer))];
  if (lower.endsWith('.xlsx')) {
    const { default: readXlsx } = await import('read-excel-file/node');
    const res = await readXlsx(buffer);
    // v9 returns every sheet: [{ sheet, data }]; older versions return rows of the first sheet.
    return Array.isArray(res) && res.length && res[0] && res[0].data ? res.map(s => s.data) : [res];
  }
  const err = new Error('Нужен файл .xlsx или .csv');
  err.userFacing = true;
  throw err;
}

// ---------- Value helpers ----------

function toDate(v) {
  if (v == null || v === '') return { value: null };
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // Excel dates come as UTC midnight — take the UTC calendar day.
    return { value: `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}` };
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return toDate(d);
  }
  const s = String(v).trim().toLowerCase();
  const today = dates.localDate();
  if (s === 'сегодня') return { value: today };
  if (s === 'завтра') return { value: dates.addDays(today, 1) };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(s);
  if (m) {
    let y = m[3] ? +m[3] : new Date().getFullYear();
    if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  return { value: null, error: `не понял дату «${v}»` };

  function valid(y, mo, d) {
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return { value: null, error: `нет такой даты «${v}»` };
    return { value: dates.localDate(dt) };
  }
}

function toTime(v) {
  if (v == null || v === '') return { value: null };
  if (v instanceof Date) return { value: `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}` };
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 24 * 60);
    return { value: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` };
  }
  const m = /^(\d{1,2})[:.](\d{2})/.exec(String(v).trim());
  if (m && +m[1] < 24 && +m[2] < 60) return { value: `${m[1].padStart(2, '0')}:${m[2]}` };
  return { value: null, error: `не понял время «${v}»` };
}

const str = v => (v == null ? '' : (v instanceof Date ? toDate(v).value : String(v))).trim();

// ---------- Plan (preview) ----------

async function plan({ buffer, filename, space }) {
  const sheets = (await readRows(buffer, filename)).map(rows => (rows || []).filter(r => Array.isArray(r) && r.some(c => str(c) !== '')));
  if (!sheets.some(s => s.length)) return { error: 'Файл пустой' };

  // Find the sheet + header row (a row with a "Клиент"-like column) within the first 10 rows.
  let raw = [];
  let headerIdx = -1;
  let map = {};
  for (const rows of sheets) {
    for (let i = 0; i < Math.min(10, rows.length) && headerIdx === -1; i++) {
      const m = {};
      rows[i].forEach((h, col) => {
        const n = norm(h);
        const c = COLUMNS.find(c => c.aliases.includes(n));
        if (c && m[c.key] === undefined) m[c.key] = col;
      });
      if (m.name !== undefined) { headerIdx = i; map = m; raw = rows; }
    }
    if (headerIdx !== -1) break;
  }
  if (headerIdx === -1) return { error: 'Не нашёл колонку «Клиент». Возьмите шаблон со страницы импорта — первая строка должна быть заголовками.' };

  const sections = db.prepare('SELECT id, name FROM sections WHERE space_id = ? ORDER BY position').all(space.id);
  const users = db.prepare('SELECT id, name, email FROM users').all();
  const findUser = v => {
    const n = norm(v);
    if (!n) return null;
    return users.find(u => norm(u.email) === n) || users.find(u => norm(u.name) === n)
      || users.find(u => norm(u.name).split(' ')[0] === n) || null;
  };

  const seen = new Map();
  const rows = [];
  raw.slice(headerIdx + 1).forEach((r, i) => {
    const get = key => (map[key] === undefined ? '' : r[map[key]]);
    const row = { line: headerIdx + i + 2, warnings: [], errors: [] };
    row.name = str(get('name'));
    if (!row.name) { row.errors.push('нет названия клиента'); rows.push(row); return; }

    const key = row.name.toLowerCase();
    if (seen.has(key)) row.warnings.push(`клиент повторяется (строка ${seen.get(key)}) — применятся обе строки по очереди`);
    seen.set(key, row.line);

    ['contact_name', 'contact_telegram', 'contact_phone', 'contact_email', 'website', 'potential_value', 'next_action', 'contact_result', 'notes']
      .forEach(k => { row[k] = str(get(k)); });

    const lt = str(get('lead_type'));
    row.lead_type = parseLeadType(lt);
    if (lt && !row.lead_type) row.warnings.push(`тип «${lt}» не понял — пишите «агентство» или «бизнес»`);

    const stage = str(get('stage'));
    if (stage) {
      const s = sections.find(x => norm(x.name) === norm(stage));
      if (s) row.section = s; else row.warnings.push(`этап «${stage}» не найден — этап не меняю`);
    }
    const owner = str(get('owner'));
    if (owner) {
      row.owner = findUser(owner);
      if (!row.owner) row.warnings.push(`ответственный «${owner}» не найден в команде`);
    }
    const ad = toDate(get('action_date'));
    if (ad.error) row.warnings.push('срок действия: ' + ad.error);
    row.action_date = ad.value;
    const at = toTime(get('action_time'));
    if (at.error) row.warnings.push(at.error);
    row.action_time = row.action_date ? at.value : null;
    if ((row.action_date) && !row.next_action) row.warnings.push('есть срок, но нет «Следующего действия» — срок пропущу');
    const nt = toDate(get('next_touch'));
    if (nt.error) row.warnings.push('следующий контакт: ' + nt.error);
    row.next_touch = nt.value;

    const client = taskService.findClientForSpace(row.name, space.id);
    row.clientId = client ? client.id : null;
    const card = client ? db.prepare('SELECT t.id, t.section_id FROM tasks t WHERE t.client_id = ? AND t.space_id = ? AND t.done = 0 ORDER BY (lower(t.title) = lower(?)) DESC, t.id DESC LIMIT 1').get(client.id, space.id, row.name) : null;
    row.cardId = card ? card.id : null;
    row.mode = !client ? 'create' : card ? 'update' : 'card';
    row.targetSection = row.section || (card ? sections.find(s => s.id === card.section_id) : sections[0]);
    rows.push(row);
  });

  const ok = rows.filter(r => !r.errors.length);
  return {
    rows,
    columnsFound: COLUMNS.filter(c => map[c.key] !== undefined).map(c => c.title),
    columnsMissing: COLUMNS.filter(c => map[c.key] === undefined).map(c => c.title),
    stats: {
      total: rows.length,
      create: ok.filter(r => r.mode === 'create').length,
      update: ok.filter(r => r.mode !== 'create').length,
      errors: rows.length - ok.length,
      actions: ok.filter(r => r.next_action).length,
    },
  };
}

// ---------- Apply ----------

function apply({ planned, space, user }) {
  const result = { created: 0, updated: 0, actions: 0, moved: 0, skipped: 0 };
  const fields = ['contact_name', 'contact_telegram', 'contact_phone', 'contact_email', 'website', 'potential_value', 'lead_type'];

  taskService.transaction(() => {
    for (const row of planned.rows) {
      if (row.errors.length) { result.skipped++; continue; }

      // Client (match by name at apply time — earlier rows may have created it).
      let client = taskService.findClientForSpace(row.name, space.id);
      if (!client) {
        const id = db.prepare('INSERT INTO clients (name) VALUES (?)').run(row.name).lastInsertRowid;
        db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'created', 'Клиент создан импортом')").run(id, user.id);
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
        result.created++;
      } else {
        result.updated++;
      }

      const sets = [];
      const vals = [];
      fields.forEach(f => { if (row[f] && row[f] !== client[f]) { sets.push(`${f} = ?`); vals.push(row[f]); } });
      if (row.notes && !(client.notes || '').includes(row.notes)) {
        sets.push('notes = ?');
        vals.push(client.notes ? `${client.notes}\n${row.notes}` : row.notes);
      }
      if (row.next_touch) { sets.push('next_touch_at = ?'); vals.push(row.next_touch); }
      if (sets.length) db.prepare(`UPDATE clients SET ${sets.join(', ')}, last_activity_at = datetime('now') WHERE id = ?`).run(...vals, client.id);

      // Card on the Sales board.
      // Several deals per client are possible — the main card (title = client name) gets the import.
      let card = db.prepare('SELECT * FROM tasks WHERE client_id = ? AND space_id = ? AND done = 0 ORDER BY (lower(title) = lower(?)) DESC, id DESC LIMIT 1').get(client.id, space.id, client.name);
      const target = row.section || row.targetSection;
      if (!card) {
        const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE section_id = ?').get(target.id).p;
        const id = db.prepare('INSERT INTO tasks (space_id, section_id, client_id, title, created_by, position) VALUES (?, ?, ?, ?, ?, ?)')
          .run(space.id, target.id, client.id, client.name, user.id, pos).lastInsertRowid;
        taskService.logTaskEvent(id, user.id, 'created', `Создана импортом в «${target.name}»`);
        card = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      } else if (row.section && row.section.id !== card.section_id) {
        const from = db.prepare('SELECT name FROM sections WHERE id = ?').get(card.section_id);
        const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE section_id = ?').get(row.section.id).p;
        db.prepare("UPDATE tasks SET section_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?").run(row.section.id, pos, card.id);
        taskService.logTaskEvent(card.id, user.id, 'moved', `${from ? from.name : '?'} → ${row.section.name} (импорт)`);
        db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'stage_change', ?)").run(client.id, user.id, `Перемещён в «${row.section.name}» (импорт)`);
        result.moved++;
      }

      if (row.owner) db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(card.id, row.owner.id);

      // Next action → subtask on the card (not duplicated on re-import).
      if (row.next_action) {
        const dup = db.prepare('SELECT id FROM subtasks WHERE task_id = ? AND done = 0 AND title = ? COLLATE NOCASE').get(card.id, row.next_action);
        if (dup) {
          if (row.action_date) db.prepare('UPDATE subtasks SET due_date = ?, due_time = ? WHERE id = ?').run(row.action_date, row.action_time, dup.id);
        } else {
          const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM subtasks WHERE task_id = ?').get(card.id).p;
          db.prepare('INSERT INTO subtasks (task_id, title, assignee_id, due_date, due_time, position) VALUES (?, ?, ?, ?, ?, ?)')
            .run(card.id, row.next_action, row.owner ? row.owner.id : null, row.action_date, row.action_time, pos);
          result.actions++;
        }
      }

      if (row.contact_result) {
        const exists = db.prepare("SELECT id FROM client_events WHERE client_id = ? AND type = 'contact_log' AND body = ?").get(client.id, row.contact_result);
        if (!exists) db.prepare("INSERT INTO client_events (client_id, user_id, type, body) VALUES (?, ?, 'contact_log', ?)").run(client.id, user.id, row.contact_result);
      }
    }
    // Keep column positions tidy.
    db.prepare('SELECT id FROM sections WHERE space_id = ?').all(space.id).forEach(s => {
      db.prepare('SELECT id FROM tasks WHERE section_id = ? ORDER BY position, id').all(s.id)
        .forEach((t, i) => db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(i, t.id));
    });
  });
  return result;
}

module.exports = { COLUMNS, plan, apply, parseCsv, toDate, toTime };
