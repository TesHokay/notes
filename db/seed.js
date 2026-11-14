require('../lib/env');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('./index');

const name = process.env.SEED_ADMIN_NAME || 'Admin';
const email = process.env.SEED_ADMIN_EMAIL || 'admin@team.local';
// Local dev keeps the old convenient default; on a server a random password is generated
// (printed once) unless SEED_ADMIN_PASSWORD is set.
const password = process.env.SEED_ADMIN_PASSWORD
  || (process.env.NODE_ENV === 'production' ? crypto.randomBytes(9).toString('base64url') : 'admin123');

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

if (existing) {
  console.log(`Пользователь ${email} уже существует, пропускаю.`);
} else {
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (name, email, password_hash, is_owner) VALUES (?, ?, ?, 1)')
    .run(name, email, hash);
  console.log('Создан владелец (owner):');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log('Смените пароль после первого входа.');
}

const inviteCode = db.prepare("SELECT value FROM settings WHERE key = 'invite_code'").get();
if (!inviteCode) {
  const code = crypto.randomBytes(4).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('invite_code', ?)").run(code);
  console.log(`Создан инвайт-код для регистрации новых участников: ${code}`);
  console.log('Посмотреть/сменить его можно в разделе «Команда» (только владелец).');
}

const spaceCount = db.prepare('SELECT COUNT(*) AS c FROM spaces').get().c;
if (spaceCount === 0) {
  const insertSpace = db.prepare('INSERT INTO spaces (name, icon, position, task_visibility, card_mode) VALUES (?, ?, ?, ?, ?)');
  const insertSection = db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)');

  const defaults = [
    { name: 'Sales', icon: '💰', visibility: 'all_members', cardMode: 'client', stages: ['Новый лид', 'Контакт', 'КП / Оффер', 'Follow-up', 'Клиент', 'Hold / Вернуться', 'Бывший', 'Неактуально'] },
    { name: 'Production', icon: '🎬', visibility: 'assignees_and_managers', cardMode: 'task', stages: ['Backlog', 'К выполнению', 'В работе', 'На проверке', 'Правки', 'Готово'] },
    { name: 'SEO / Website', icon: '🌐', visibility: 'all_members', cardMode: 'task', stages: ['К выполнению', 'В работе', 'Готово'] },
    { name: 'Strategy', icon: '🎯', visibility: 'all_members', cardMode: 'task', stages: ['Идеи', 'Запланировано', 'В работе', 'Готово'] },
  ];

  defaults.forEach((s, i) => {
    const info = insertSpace.run(s.name, s.icon, i, s.visibility, s.cardMode);
    s.stages.forEach((stageName, j) => insertSection.run(info.lastInsertRowid, stageName, j));
  });

  console.log('Созданы стандартные пространства с готовыми колонками: Sales, Production, SEO / Website, Strategy.');
  console.log('Strategy изначально не видна никому, кроме владельцев — добавьте туда участников вручную, если нужно.');
}

const channelCount = db.prepare('SELECT COUNT(*) AS c FROM channels').get().c;
if (channelCount === 0) {
  const insertChannel = db.prepare('INSERT INTO channels (name, position) VALUES (?, ?)');
  ['general', 'references', 'announcements', 'random'].forEach((n, i) => insertChannel.run(n, i));
  console.log('Созданы каналы общего фида: #general, #references, #announcements, #random.');
}
