const express = require('express');
const trash = require('../lib/trash');

const router = express.Router();

const ERRORS = {
  space_gone: 'Пространство этой задачи удалено — восстановить некуда.',
  parent_gone: 'Задача, к которой относилась подзадача, удалена. Сначала восстановите её.',
  already_exists: 'Этот элемент уже восстановлен.',
  not_found: 'Элемент не найден — возможно, его уже восстановили или удалили навсегда.',
};

router.get('/', (req, res) => {
  const items = trash.listFor(req.user);
  const restored = req.query.restored ? Number(req.query.restored) : null;
  res.render('trash', {
    items, keepDays: trash.KEEP_DAYS, restoredTaskId: restored,
    error: ERRORS[req.query.error] || null, activeNav: 'trash', title: 'Корзина',
  });
});

router.post('/:id/restore', (req, res) => {
  const row = trash.listFor(req.user).find(r => r.id === Number(req.params.id));
  if (!trash.canRestore(req.user, row)) return res.redirect('/trash?error=not_found');
  const result = trash.restore(row.id, req.user);
  if (result.error) return res.redirect(`/trash?error=${result.error}`);
  res.redirect(`/trash?restored=${result.taskId}`);
});

router.post('/:id/purge', (req, res) => {
  const row = trash.listFor(req.user).find(r => r.id === Number(req.params.id));
  if (!row || !row.can_purge) return res.status(403).send('Удалять навсегда может только владелец');
  trash.purge(row.id);
  res.redirect('/trash');
});

module.exports = router;
