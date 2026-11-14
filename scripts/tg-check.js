// Telegram diagnostics: is the token valid and Telegram reachable from this server (and how
// reliably), who is linked, what timed reminders are pending. Sends a test message to linked users.
// Usage: node scripts/tg-check.js
require('../lib/env');
const db = require('../db');

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const api = m => `https://api.telegram.org/bot${token}/${m}`;

async function call(method, body) {
  const res = await fetch(api(method), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

(async () => {
  console.log('Часовой пояс:', process.env.TZ || '(не задан)', '| время сервера:', new Date().toString());
  if (!token) return console.log('❌ TELEGRAM_BOT_TOKEN пустой в .env');

  let ok = 0; let botName = '';
  const tries = 10;
  for (let i = 0; i < tries; i++) {
    try { const me = await call('getMe'); if (me.ok) { ok++; botName = me.result.username; } else console.log('❌ Telegram:', me.description); }
    catch { /* counted as failure */ }
  }
  console.log(`Связь с Telegram: ${ok} из ${tries} попыток успешно${botName ? ` (бот @${botName})` : ''}`);

  const users = db.prepare('SELECT id, name, telegram_chat_id FROM users ORDER BY id').all();
  users.forEach(u => console.log(`${u.telegram_chat_id ? '✅' : '❌'} ${u.name} — ${u.telegram_chat_id ? 'Telegram привязан' : 'Telegram НЕ привязан'}`));

  const pending = db.prepare(`
    SELECT 'задача' AS kind, t.title, t.due_date, t.due_time, t.reminded_60 FROM tasks t
      WHERE t.done = 0 AND t.due_time IS NOT NULL
    UNION ALL
    SELECT 'подзадача', s.title, s.due_date, s.due_time, s.reminded_60 FROM subtasks s
      WHERE s.done = 0 AND s.due_time IS NOT NULL
    ORDER BY 3 DESC, 4 DESC LIMIT 8
  `).all();
  pending.forEach(t => console.log(`• ${t.kind} «${t.title}» ${t.due_date} ${t.due_time}: напоминание за час ${t.reminded_60 ? 'уже обработано' : 'ещё впереди'}`));

  for (const u of users.filter(x => x.telegram_chat_id)) {
    let sent = false;
    for (let i = 0; i < 4 && !sent; i++) {
      try { sent = (await call('sendMessage', { chat_id: u.telegram_chat_id, text: '🔔 Тестовое сообщение от PulsAura CRM — уведомления работают.' })).ok; }
      catch { await new Promise(r => setTimeout(r, 3000)); }
    }
    console.log(sent ? `✅ Тест отправлен: ${u.name}` : `❌ Не удалось отправить ${u.name}`);
  }
})();
