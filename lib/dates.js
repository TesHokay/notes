// Date helpers. Everything is computed in the server's local timezone
// (process.env.TZ, defaults to Europe/Moscow in server.js). The old code used
// toISOString().slice(0, 10), which is the UTC date and is wrong for
// UTC+3 between 00:00 and 03:00 ("today" was still yesterday).

const MONTHS_SHORT = ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const pad = n => String(n).padStart(2, '0');

// "четверг, 25 сентября" for a date string (section headers on Home).
function dayTitle(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_FULL[new Date(y, m - 1, d).getDay()]}, ${d} ${MONTHS_FULL[m - 1]}`;
}

// Short name of the team's time zone, shown next to every time ("00:25 МСК") so people in other
// zones aren't misled. TZ_LABEL in .env overrides; otherwise known zones, else "GMT+N".
const TZ_NAMES = { 'Europe/Moscow': 'МСК', 'Asia/Yekaterinburg': 'ЕКБ', 'Europe/Samara': 'САМ', 'Asia/Novosibirsk': 'НСК', 'Europe/Kaliningrad': 'КЛД' };
function tzLabel() {
  if (process.env.TZ_LABEL) return process.env.TZ_LABEL;
  if (TZ_NAMES[process.env.TZ]) return TZ_NAMES[process.env.TZ];
  const part = new Intl.DateTimeFormat('ru-RU', { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName');
  return part ? part.value : '';
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function isValidTime(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
}

// Returns { label, full, state, tz } where state is 'overdue' | 'today' | 'soon' | ''.
// `full` carries the zone ("…, 00:25 МСК"); `label` doesn't — views render `tz` as a small mark.
function dueInfo(date, time, now = new Date()) {
  if (!date) return { label: '', full: '', state: '', tz: '' };
  const tz = time ? tzLabel() : '';
  const today = localDate(now);
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  // Relative words always come with the weekday, plain dates with it too: "Завтра · пт", "сб, 27 сент.".
  let label;
  const rel = date === today ? 'Сегодня' : date === addDays(today, 1) ? 'Завтра' : date === addDays(today, 2) ? 'Послезавтра'
    : date === addDays(today, -1) ? 'Вчера' : null;
  if (rel) label = `${rel} · ${WEEKDAYS_SHORT[wd]}`;
  else label = `${WEEKDAYS_SHORT[wd]}, ${d} ${MONTHS_SHORT[m - 1]}` + (y !== now.getFullYear() ? ` ${y}` : '');
  if (time) label += `, ${time}`;

  const full = `${WEEKDAYS_FULL[wd]}, ${d} ${MONTHS_FULL[m - 1]} ${y}` + (time ? `, ${time}${tz ? ` ${tz}` : ''}` : '');

  let state = '';
  if (date < today || (date === today && time && time < localTime(now))) state = 'overdue';
  else if (date === today) state = 'today';
  else if (date <= addDays(today, 2)) state = 'soon';
  return { label, full, state, tz };
}

module.exports = { localDate, localTime, addDays, dueInfo, dayTitle, isValidDate, isValidTime, tzLabel, MONTHS_FULL, WEEKDAYS_SHORT };
