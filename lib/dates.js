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
  const part = new Intl.DateTimeFormat('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow', timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName');
  return part ? part.value : '';
}

function localDate(d = new Date()) {
  if (process.env.CRM_CLOUDFLARE) { const p = zonedParts(d); return `${p.year}-${p.month}-${p.day}`; }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()) {
  if (process.env.CRM_CLOUDFLARE) { const p = zonedParts(d); return `${p.hour}:${p.minute}`; }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return calendarDate(new Date(y, m - 1, d + days));
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
  else label = `${WEEKDAYS_SHORT[wd]}, ${d} ${MONTHS_SHORT[m - 1]}` + (y !== Number(localDate(now).slice(0, 4)) ? ` ${y}` : '');
  if (time) label += `, ${time}`;

  const full = `${WEEKDAYS_FULL[wd]}, ${d} ${MONTHS_FULL[m - 1]} ${y}` + (time ? `, ${time}${tz ? ` ${tz}` : ''}` : '');

  let state = '';
  if (date < today || (date === today && time && time < localTime(now))) state = 'overdue';
  else if (date === today) state = 'today';
  else if (date <= addDays(today, 2)) state = 'soon';
  return { label, full, state, tz };
}


// Workers run in UTC. Wall-clock deadlines always belong to the configured CRM zone.
function zonedParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function calendarDate(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function hour(now = new Date()) { return Number(localTime(now).slice(0,2)); }
function zonedDate(date, time = '00:00') {
  const [y,m,d] = date.split('-').map(Number);
  const [h,min] = time.split(':').map(Number);
  if (!process.env.CRM_CLOUDFLARE) return new Date(y,m-1,d,h,min);
  const wall = Date.UTC(y,m-1,d,h,min);
  let instant = wall;
  for (let i=0;i<3;i++) {
    const p=zonedParts(new Date(instant));
    const shown=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const difference=wall-shown;
    if (!difference) break;
    instant += difference;
  }
  return new Date(instant);
}

function tzOffsetMinutes(now = new Date()) {
  if (!process.env.CRM_CLOUDFLARE) return -now.getTimezoneOffset();
  const p = zonedParts(now);
  return Math.round((Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(now.getTime()/1000)*1000)/60000);
}
module.exports = { tzOffsetMinutes, calendarDate, hour, zonedDate, localDate, localTime, addDays, dueInfo, dayTitle, isValidDate, isValidTime, tzLabel, MONTHS_FULL, WEEKDAYS_SHORT };
