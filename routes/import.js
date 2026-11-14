const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const db = require('../db');
const perms = require('../lib/permissions');
const importService = require('../lib/import-service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// Previews waiting for "Применить" (in memory, 30 min).
const pending = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}, 5 * 60 * 1000).unref();

function loadSpace(req, res) {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
  if (!space) { res.status(404).send('Пространство не найдено'); return null; }
  if (!perms.canManageSpace(req.user, space.id)) { res.status(403).send('Импорт доступен менеджерам пространства'); return null; }
  if (space.card_mode !== 'client') { res.status(400).send('Импорт клиентов доступен в пространствах-воронках (Sales)'); return null; }
  return space;
}

function aiPrompt(space) {
  const stages = db.prepare('SELECT name FROM sections WHERE space_id = ? ORDER BY position').all(space.id).map(s => s.name);
  const users = db.prepare('SELECT name FROM users ORDER BY name').all().map(u => u.name);
  return [
    'Преобразуй данные ниже в таблицу для импорта в CRM PulsAura.',
    'Колонки — строго с такими заголовками и в таком порядке:',
    importService.COLUMNS.map(c => c.title).join(' | '),
    '',
    'Правила:',
    '— одна строка = один клиент; «Клиент» обязателен;',
    `— «Этап» — только одно из: ${stages.join(', ')};`,
    `— «Ответственный» — только одно из: ${users.join(', ')};`,
    '— «Следующее действие» — что конкретно сделать дальше (например «Отправить КП»), «Срок действия» — когда;',
    '— даты в формате ДД.ММ.ГГГГ, время ЧЧ:ММ;',
    '— «Итог контакта» — коротко, о чём договорились в последний раз;',
    '— если данных нет — оставь ячейку пустой, ничего не придумывай.',
    'Верни файл .xlsx (или CSV с разделителем «;»).',
    '',
    'Данные:',
  ].join('\n');
}

function render(res, req, space, extra) {
  res.render('import', {
    space, aiPrompt: aiPrompt(space), columns: importService.COLUMNS,
    stages: db.prepare('SELECT name FROM sections WHERE space_id = ? ORDER BY position').all(space.id).map(s => s.name),
    planned: null, token: null, result: null, error: null,
    activeNav: `space-${space.id}`, title: `Импорт — ${space.name}`,
    ...extra,
  });
}

router.get('/:id/import', (req, res) => {
  const space = loadSpace(req, res);
  if (space) render(res, req, space);
});

router.get('/:id/import/template.xlsx', (req, res) => {
  const space = loadSpace(req, res);
  if (space) res.download(path.join(__dirname, '..', 'assets', 'pulsaura-import-template.xlsx'), 'PulsAura — шаблон импорта клиентов.xlsx');
});

router.post('/:id/import/preview', upload.single('file'), async (req, res) => {
  const space = loadSpace(req, res);
  if (!space) return;
  if (!req.file) return render(res, req, space, { error: 'Выберите файл .xlsx или .csv' });
  try {
    const planned = await importService.plan({ buffer: req.file.buffer, filename: req.file.originalname, space });
    if (planned.error) return render(res, req, space, { error: planned.error });
    const token = crypto.randomBytes(12).toString('hex');
    pending.set(token, { planned, spaceId: space.id, userId: req.user.id, at: Date.now(), filename: req.file.originalname });
    render(res, req, space, { planned, token, filename: req.file.originalname });
  } catch (err) {
    console.error('[import]', err);
    render(res, req, space, { error: err.userFacing ? err.message : 'Не получилось прочитать файл. Сохраните его как .xlsx и попробуйте ещё раз.' });
  }
});

router.post('/:id/import/apply', (req, res) => {
  const space = loadSpace(req, res);
  if (!space) return;
  const item = pending.get(req.body.token);
  if (!item || item.spaceId !== space.id || item.userId !== req.user.id) {
    return render(res, req, space, { error: 'Превью устарело — загрузите файл ещё раз.' });
  }
  pending.delete(req.body.token);
  try {
    const result = importService.apply({ planned: item.planned, space, user: req.user });
    render(res, req, space, { result });
  } catch (err) {
    console.error('[import apply]', err);
    render(res, req, space, { error: 'Импорт не применён (ничего не изменено): ' + err.message });
  }
});

module.exports = router;
