const express = require('express');
const db = require('../db');
const perms = require('../lib/permissions');

const router = express.Router();

// Projects are metadata/a filter now, not a separate screen — clicking one
// just opens the space board pre-filtered to it.
router.get('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).send('Проект не найден');
  if (!perms.canOpenSpace(req.user, project.space_id)) return res.status(403).send('У вас нет доступа к этому пространству');
  res.redirect(`/spaces/${project.space_id}?project=${project.id}`);
});

module.exports = router;
