const db = require('../db');
const dates = require('./dates');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const API = `https://api.telegram.org/bot${TOKEN}`;

const enabled = Boolean(TOKEN);

if (!enabled) {
  console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — уведомления в Telegram отключены.');
}

// Connections from some hosting providers to api.telegram.org drop intermittently,
// so network failures are retried a few times with a pause (API errors are not).
async function callApi(method, params, attempts = 4) {
  if (!enabled) return null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (!data.ok) console.error(`[telegram] ${method} error:`, data.description);
      return data;
    } catch (err) {
      console.error(`[telegram] ${method} failed (попытка ${i}/${attempts}):`, err.message);
      if (i < attempts) await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
  return null;
}

function sendMessage(chatId, text, replyMarkup) {
  if (!chatId) return;
  return callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

function taskLink(taskId) {
  return `${APP_URL}/tasks/${taskId}`;
}

// "Открыть" opens the CRM as a Telegram Mini App: /tg logs the person in via Telegram
// (no password in Telegram's in-app browser) and then shows the task.
function openButton(taskId) {
  return { text: 'Открыть', web_app: { url: `${APP_URL}/tg?next=${encodeURIComponent(`/tasks/${taskId}`)}` } };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function chatIdFor(userId) {
  const user = db.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').get(userId);
  return user ? user.telegram_chat_id : null;
}

function taskButtons(taskId) {
  return {
    inline_keyboard: [[
      { text: '✅ Готово', callback_data: `done:${taskId}` },
      openButton(taskId),
    ]],
  };
}

function meetingButtons(task) {
  const row = [];
  if (task.meeting_url) row.push({ text: '📞 Подключиться', url: task.meeting_url });
  row.push(openButton(task.id));
  return { inline_keyboard: [row] };
}

function whenLabel(task) {
  return task.due_date ? dates.dueInfo(task.due_date, task.due_time).full : 'время не назначено';
}

function notifyAssigned(assigneeUserId, task, projectName, actorName) {
  const chatId = chatIdFor(assigneeUserId);
  if (!chatId) return;
  if (task.kind === 'meeting') {
    return sendMessage(
      chatId,
      `📞 ${escapeHtml(actorName)} зовёт вас на созвон:\n<b>${escapeHtml(task.title)}</b>\n🕒 ${escapeHtml(whenLabel(task))}` + (task.meeting_url ? `\n🔗 ${escapeHtml(task.meeting_url)}` : ''),
      meetingButtons(task)
    );
  }
  const due = task.due_date ? `\nСрок: ${escapeHtml(whenLabel(task))}` : '';
  sendMessage(
    chatId,
    `📌 ${actorName} назначил(а) вам задачу в проекте «${escapeHtml(projectName)}»:\n<b>${escapeHtml(task.title)}</b>${due}`,
    taskButtons(task.id)
  );
}

function notifyComment(task, projectName, comment, authorName, recipientUserId) {
  const chatId = chatIdFor(recipientUserId);
  if (!chatId) return;
  sendMessage(
    chatId,
    `💬 ${authorName} прокомментировал(а) задачу «${escapeHtml(task.title)}» (${escapeHtml(projectName)}):\n${escapeHtml(comment)}`,
    taskButtons(task.id)
  );
}

function notifyDue(assigneeUserId, task, projectName) {
  const chatId = chatIdFor(assigneeUserId);
  if (!chatId) return;
  const overdue = task.due_date < dates.localDate();
  const label = overdue ? '⚠️ Просрочена' : '⏰ Срок сегодня';
  sendMessage(chatId, `${label}: <b>${escapeHtml(task.title)}</b> (${escapeHtml(projectName)})`, taskButtons(task.id));
}

function notifyMeetingMoved(userId, task, actorName) {
  const chatId = chatIdFor(userId);
  if (!chatId) return;
  sendMessage(chatId, `🔁 ${escapeHtml(actorName)} перенёс(ла) созвон <b>${escapeHtml(task.title)}</b>\nТеперь: ${escapeHtml(whenLabel(task))}`, meetingButtons(task));
}

// «Через час» when on schedule; the real remaining minutes when the reminder is late
// (task created or app woken up less than an hour before the deadline).
const inLabel = minutes => (minutes >= 55 ? 'Через час' : `Через ${minutes} мин`);

// Time-based reminders (every minute): meetings — 60 and 10 minutes before,
// tasks with a time — 60 minutes before the deadline.
function checkReminders(now = new Date()) {
  if (!enabled) return;
  const today = dates.localDate(now);
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE done = 0 AND due_date IS NOT NULL AND due_time IS NOT NULL
      AND due_date BETWEEN ? AND ? AND (reminded_60 = 0 OR (kind = 'meeting' AND reminded_10 = 0))
  `).all(dates.addDays(today, -1), dates.addDays(today, 1));
  for (const task of rows) {
    const [y, m, d] = task.due_date.split('-').map(Number);
    const [hh, mm] = task.due_time.split(':').map(Number);
    const minutes = Math.round((new Date(y, m - 1, d, hh, mm) - now) / 60000);
    const people = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id).map(r => r.user_id);
    const isMeeting = task.kind === 'meeting';
    if (!task.reminded_60 && minutes <= 60) {
      if (minutes > 15) {
        people.forEach(uid => {
          const chatId = chatIdFor(uid);
          if (chatId) sendMessage(chatId, isMeeting
            ? `⏰ ${inLabel(minutes)} созвон: <b>${escapeHtml(task.title)}</b> (${escapeHtml(task.due_time)} ${dates.tzLabel()})`
            : `⏰ ${inLabel(minutes)} срок: <b>${escapeHtml(task.title)}</b> (${escapeHtml(task.due_time)} ${dates.tzLabel()})`, isMeeting ? meetingButtons(task) : taskButtons(task.id));
        });
      }
      db.prepare('UPDATE tasks SET reminded_60 = 1 WHERE id = ?').run(task.id);
    }
    if (isMeeting && !task.reminded_10 && minutes <= 10) {
      if (minutes > -5) {
        people.forEach(uid => {
          const chatId = chatIdFor(uid);
          if (chatId) sendMessage(chatId, `📞 Через ${Math.max(minutes, 0)} мин созвон: <b>${escapeHtml(task.title)}</b>` + (task.meeting_url ? `\n🔗 ${escapeHtml(task.meeting_url)}` : ''), meetingButtons(task));
        });
      }
      db.prepare('UPDATE tasks SET reminded_10 = 1 WHERE id = ?').run(task.id);
    }
  }

  // Subtasks with a time: 60 minutes before, to every assignee of the subtask.
  const subs = db.prepare(`
    SELECT s.*, t.title AS task_title FROM subtasks s JOIN tasks t ON t.id = s.task_id
    WHERE s.done = 0 AND t.done = 0 AND s.reminded_60 = 0
      AND EXISTS (SELECT 1 FROM subtask_assignees sa WHERE sa.subtask_id = s.id)
      AND s.due_date IS NOT NULL AND s.due_time IS NOT NULL AND s.due_date BETWEEN ? AND ?
  `).all(dates.addDays(today, -1), dates.addDays(today, 1));
  for (const s of subs) {
    const [y, m, d] = s.due_date.split('-').map(Number);
    const [hh, mm] = s.due_time.split(':').map(Number);
    const minutes = Math.round((new Date(y, m - 1, d, hh, mm) - now) / 60000);
    if (minutes > 60) continue;
    if (minutes > 15) {
      db.prepare('SELECT user_id FROM subtask_assignees WHERE subtask_id = ?').all(s.id).forEach(({ user_id: uid }) => {
        const chatId = chatIdFor(uid);
        if (chatId) sendMessage(chatId, `⏰ ${inLabel(minutes)} срок: <b>${escapeHtml(s.title)}</b> (${escapeHtml(s.task_title)}, ${escapeHtml(s.due_time)} ${dates.tzLabel()})`,
          { inline_keyboard: [[openButton(s.task_id)]] });
      });
    }
    db.prepare('UPDATE subtasks SET reminded_60 = 1 WHERE id = ?').run(s.id);
  }
}

// "Срок сегодня / Просрочена" only in waking hours (CRM time): what comes due at night is sent at
// QUIET_END in the morning. Timed reminders (an hour before) are not affected.
const QUIET_END = 9;    // from 09:00
const QUIET_START = 21; // until 21:00

function inQuietHours(now = new Date()) {
  const h = now.getHours();
  return h < QUIET_END || h >= QUIET_START;
}

function checkDueDates(now = new Date()) {
  if (!enabled || inQuietHours(now)) return;
  const today = dates.localDate(now);
  const dueTasks = db.prepare(`
    SELECT t.*, p.name AS project_name, s.name AS space_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    JOIN spaces s ON s.id = t.space_id
    WHERE t.done = 0 AND t.due_notified = 0 AND t.due_date IS NOT NULL AND t.due_date <= ? AND t.kind != 'meeting'
  `).all(today);

  for (const task of dueTasks) {
    const assignees = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id);
    const where = [task.space_name, task.project_name].filter(Boolean).join(' · ');
    assignees.forEach(a => notifyDue(a.user_id, task, where));
    db.prepare('UPDATE tasks SET due_notified = 1 WHERE id = ?').run(task.id);
  }
}

function sendOwnerDigest() {
  if (!enabled) return;
  const today = dates.localDate();
  const alreadySent = db.prepare("SELECT value FROM settings WHERE key = 'digest_sent_date'").get();
  if (alreadySent && alreadySent.value === today) return;

  const hour = new Date().getHours();
  if (hour < 8 || hour > 10) return;

  const owners = db.prepare('SELECT id, telegram_chat_id FROM users WHERE is_owner = 1 AND telegram_chat_id IS NOT NULL').all();
  if (!owners.length) return;

  // Same numbers as on Home / «Сводка команды» (PulsAura only, subtasks included).
  const counts = require('./team-overview').teamCounts();
  const dueToday = counts.todayCount;
  const overdue = counts.overdueCount;
  const unassigned = counts.unassignedCount;

  let text = `☀️ PulsAura — утро\n${dueToday} задач сегодня\n${overdue} просрочено\n${unassigned} задач без исполнителя`;

  // Clients with an open deal and no movement for a while — time to get in touch.
  const { clientOverview, QUIET_DAYS } = require('./client-overview');
  const quiet = clientOverview(null).filter(r => r.quiet).sort((a, b) => b.idleDays - a.idleDays);
  let markup;
  if (quiet.length) {
    const list = quiet.slice(0, 8).map(r => `• ${escapeHtml(r.client.name)} — ${r.idleDays} дн.${r.stage ? ` (${escapeHtml(r.stage.name)})` : ''}`).join('\n');
    text += `\n\n🤝 Давно не на связи (${QUIET_DAYS}+ дней без движения):\n${list}` + (quiet.length > 8 ? `\n…и ещё ${quiet.length - 8}` : '')
      + '\nНапишите им или поставьте следующий шаг.';
    markup = { inline_keyboard: [[{ text: 'Открыть клиентов', web_app: { url: `${APP_URL}/tg?next=${encodeURIComponent('/clients?f=quiet')}` } }]] };
  }

  owners.forEach(o => sendMessage(o.telegram_chat_id, text, markup));
  db.prepare("INSERT INTO settings (key, value) VALUES ('digest_sent_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    if (cq.data && cq.data.startsWith('done:')) {
      const taskId = Number(cq.data.split(':')[1]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      const user = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(String(chatId));
      if (task) require('./task-service').setTaskDone(task, true, user ? user.id : null);
      await callApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'Отмечено выполненным' });
      await sendMessage(chatId, '✅ Задача отмечена выполненной.');
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith('/start')) {
    const code = text.split(' ')[1];
    if (!code) {
      return sendMessage(chatId, 'Привет! Зайдите в профиль на сайте и нажмите «Подключить Telegram», чтобы получить персональную ссылку.');
    }
    const user = db.prepare('SELECT id, name FROM users WHERE telegram_link_code = ?').get(code);
    if (!user) {
      return sendMessage(chatId, 'Код не найден или уже использован. Получите новую ссылку в профиле на сайте.');
    }
    db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_link_code = NULL WHERE id = ?').run(String(chatId), user.id);
    return sendMessage(chatId, `Готово, ${user.name}! Теперь уведомления по задачам будут приходить сюда.`);
  }
}

let pollOffset = 0;
let polling = false;

async function pollLoop() {
  if (!enabled || polling) return;
  polling = true;
  while (polling) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=25&offset=${pollOffset}&allowed_updates=["message","callback_query"]`,
        { signal: AbortSignal.timeout(40000) });
      const data = await res.json();
      if (data.ok) {
        for (const update of data.result) {
          pollOffset = update.update_id + 1;
          await handleUpdate(update);
        }
      }
    } catch (err) {
      console.error('[telegram] polling error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function start() {
  if (!enabled) return;
  // Bot menu button "CRM" (next to the message field) opens the CRM with Telegram login.
  if (APP_URL.startsWith('https://')) {
    callApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'CRM', web_app: { url: `${APP_URL}/tg` } } });
  }
  pollLoop();
  checkDueDates();
  setInterval(checkDueDates, 10 * 60 * 1000); // often enough that the morning batch comes right after 09:00
  checkReminders();
  setInterval(checkReminders, 60 * 1000);
  setInterval(sendOwnerDigest, 15 * 60 * 1000);
  console.log('[telegram] бот запущен (long polling)');
}

module.exports = { enabled, sendMessage, notifyAssigned, notifyMeetingMoved, checkReminders, notifyComment, notifyDue, checkDueDates, start };
