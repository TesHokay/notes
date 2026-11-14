const express = require('express');
const db = require('../db');
const perms = require('../lib/permissions');
const { transaction } = require('../lib/task-service');
const { renderToString } = require('../lib/render');

const router = express.Router();

router.post('/spaces/:spaceId/sections', async (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.spaceId);
  if (!space) return res.status(404).json({ error: 'space_not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM sections WHERE space_id = ?').get(space.id).m;
  const info = db.prepare('INSERT INTO sections (space_id, name, position) VALUES (?, ?, ?)')
    .run(space.id, name, maxPos + 1);

  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    section,
    html: await renderToString(req, 'partials/board-column', {
      section: { ...section, tasks: [] }, cardMode: space.card_mode, canManage: true, canCreate: true,
    }),
  });
});

function getSpaceForSection(sectionId) {
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId);
  if (!section) return { section: null, space: null };
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(section.space_id);
  return { section, space };
}

router.patch('/sections/:id', (req, res) => {
  const { section, space } = getSpaceForSection(req.params.id);
  if (!section) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(name, section.id);
  res.json({ ok: true });
});

// Swap a column with its left/right neighbour. Positions are renumbered 0..n-1 first so
// gaps or duplicates left by older data can't make the swap a no-op.
router.post('/sections/:id/move', (req, res) => {
  const { section, space } = getSpaceForSection(req.params.id);
  if (!section) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const ids = db.prepare('SELECT id FROM sections WHERE space_id = ? ORDER BY position, id').all(space.id).map(r => r.id);
  const from = ids.indexOf(section.id);
  const to = req.body.direction === 'left' ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return res.json({ ok: true, moved: false });
  [ids[from], ids[to]] = [ids[to], ids[from]];
  const setPos = db.prepare('UPDATE sections SET position = ? WHERE id = ?');
  try {
    transaction(() => ids.forEach((id, i) => setPos.run(i, id)));
  } catch (err) {
    return res.status(500).json({ error: 'move_failed' });
  }
  res.json({ ok: true, moved: true });
});

router.delete('/sections/:id', (req, res) => {
  const { section, space } = getSpaceForSection(req.params.id);
  if (!section) return res.status(404).json({ error: 'not_found' });
  if (!perms.canManageSpace(req.user, space.id)) return res.status(403).json({ error: 'forbidden' });

  const remaining = db.prepare('SELECT COUNT(*) AS c FROM sections WHERE space_id = ?').get(section.space_id).c;
  if (remaining <= 1) return res.status(400).json({ error: 'last_section' });
  // Never cascade-delete work: refuse while active tasks are in the column,
  // and re-home completed ones to the first remaining column.
  const active = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE section_id = ? AND done = 0').get(section.id).c;
  if (active > 0) return res.status(400).json({ error: 'not_empty', count: active });
  const fallback = db.prepare('SELECT id FROM sections WHERE space_id = ? AND id != ? ORDER BY position LIMIT 1').get(section.space_id, section.id);
  try {
    transaction(() => {
      db.prepare('UPDATE tasks SET section_id = ? WHERE section_id = ?').run(fallback.id, section.id);
      db.prepare('DELETE FROM sections WHERE id = ?').run(section.id);
    });
  } catch (err) {
    return res.status(500).json({ error: 'delete_failed' });
  }
  res.json({ ok: true });
});

module.exports = router;
