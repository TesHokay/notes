const { dueInfo, localDate, localTime, tzOffsetMinutes, tzLabel, dayTitle, addDays, MONTHS_FULL } = require('./dates');

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function priorityLabel(p) {
  return p === 'high' ? 'Высокий' : p === 'medium' ? 'Средний' : 'Низкий';
}

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || '';
}

// "2026-09-23 06:15:00" (UTC from SQLite datetime('now')) -> local "23 сент., 09:15"
function fmtTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return ts;
  const date = localDate(d);
  const time = localTime(d);
  return dueInfo(date, time).label;
}

// Sales card title: "Клиент" or "Клиент / Сделка" when the card's own title
// (deal / product) differs from the client name.
function dealTitle(clientName, title) {
  if (!clientName) return title;
  if (!title || title.trim().toLowerCase() === clientName.trim().toLowerCase()) return clientName;
  return `${clientName} / ${title}`;
}

// Small muted zone mark after a time, e.g. <span class="tz-mark">МСК</span>. Empty without a time.
function tzMark(tz) {
  return tz ? ` <span class="tz-mark" title="Время указано по часовому поясу CRM">${tz}</span>` : '';
}

// "чт 25.09" for a day `offset` days from today (quick date buttons).
function shortDay(offset) {
  const [y, m, d] = addDays(localDate(), offset).split('-').map(Number);
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(y, m - 1, d).getDay()];
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

// "с 28 сентября" for the Home "Позже" header.
function fromDay(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `с ${d} ${MONTHS_FULL[m - 1]}`;
}

// Sales lead segment.
const LEAD_TYPES = { agency: 'Агентство', business: 'Бизнес' };
// Free text (Excel cell, form value) → 'agency' | 'business' | ''.
function parseLeadType(v) {
  const s = String(v || '').trim().toLocaleLowerCase('ru');
  if (!s) return '';
  if (LEAD_TYPES[s]) return s;
  if (/агент|agency|студи|продакшн|production/.test(s)) return 'agency';
  if (/бизнес|business|компан|клиент|бренд|brand|прям/.test(s)) return 'business';
  return '';
}

// Phone for tel: / wa.me links: digits only; a leading 8 of a Russian 11-digit number becomes 7.
function phoneDigits(phone, withPlus) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d ? (withPlus ? '+' + d : d) : '';
}

module.exports = { tzOffsetMinutes, LEAD_TYPES, parseLeadType, phoneDigits, dealTitle, initials, priorityLabel, firstName, dueInfo, fmtTimestamp, localDate, tzLabel, tzMark, dayTitle, addDays, fromDay, shortDay, repeatRules: require('./recurrence').RULES };
