/*
 * Kanban drag & drop on Pointer Events (same model as dnd-kit: PointerSensor
 * with an activation distance, a DragOverlay that follows the cursor, a
 * placeholder in the destination list, closest-column collision detection).
 *
 * Why not native HTML5 drag & drop any more (root cause of the old bug):
 *  - the old code moved the real card inside `dragover`, but saved only in
 *    `drop` on `.column-body`. Releasing over a column header, the
 *    "+ Добавить" button, the gap between columns or below a short column
 *    fired no `drop` → the card stayed where it was visually but was never
 *    saved → it "jumped back" after refresh;
 *  - an empty column's `.column-body` had 0px height → no drop target at all;
 *  - the saved position was an index among VISIBLE cards, while the server
 *    re-numbered ALL cards (incl. completed / filtered / hidden) → reorder
 *    landed in the wrong place.
 *
 * Here the whole column is the drop zone, the drop always resolves to the
 * placeholder slot (what you see is what is saved), and the caller receives
 * neighbour ids instead of an index.
 */
(function () {
  const ACTIVATION_DISTANCE = 5;   // px before a press becomes a drag
  const TOUCH_DELAY = 220;         // ms long-press for touch
  const EDGE = 60;                 // px auto-scroll edge
  const INTERACTIVE = 'button, input, select, textarea, form, label, [data-no-drag]';

  window.initBoardDnd = function (board, { onDrop, onSubtaskDrop }) {
    let pending = null;
    let drag = null;
    let lastPointer = { x: 0, y: 0 };
    let rafId = null;

    const columns = () => Array.from(board.querySelectorAll('.column'));

    board.addEventListener('dragstart', e => e.preventDefault()); // no native DnD (links/images)

    board.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      if (board.dataset.completedView === '1') return;
      const card = e.target.closest('.task-card');
      if (!card || !board.contains(card)) return;
      // A subtask row (its text or background, not its checkbox / pickers)
      // can be dragged out into another column → becomes its own card.
      const sub = e.target.closest('.tc-sub');
      const subDraggable = sub && !e.target.closest('.check-box, .qp-btn, input');
      if (!subDraggable && e.target.closest(INTERACTIVE)) return;
      pending = { card, sub: subDraggable ? sub : null, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType === 'touch', ready: e.pointerType !== 'touch' };
      if (pending.touch) {
        const p = pending;
        p.timer = setTimeout(() => { if (pending === p) { p.ready = true; start(p.x, p.y); } }, TOUCH_DELAY);
      }
    });

    document.addEventListener('pointermove', (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      if (pending && !drag) {
        const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
        if (pending.touch) {
          if (dist > ACTIVATION_DISTANCE) { clearTimeout(pending.timer); pending = null; } // user is scrolling
          return;
        }
        if (dist < ACTIVATION_DISTANCE) return;
        start(e.clientX, e.clientY);
      }
      if (drag) {
        e.preventDefault();
        update(e.clientX, e.clientY);
      }
    }, { passive: false });

    document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerup', () => { finishPending(); if (drag) end(true); });
    document.addEventListener('pointercancel', () => { finishPending(); if (drag) end(false); });
    document.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') { e.stopPropagation(); end(false); } }, true);
    window.addEventListener('blur', () => { if (drag) end(false); });

    function finishPending() {
      if (pending && pending.timer) clearTimeout(pending.timer);
      pending = null;
    }

    function start(x, y) {
      if (pending.sub) return startSubtask(x, y);
      const card = pending.card;
      const rect = card.getBoundingClientRect();

      const overlay = card.cloneNode(true);
      overlay.classList.add('drag-overlay');
      overlay.removeAttribute('data-task-id');
      overlay.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
      Object.assign(overlay.style, { width: rect.width + 'px', left: rect.left + 'px', top: rect.top + 'px' });
      document.body.appendChild(overlay);

      const placeholder = document.createElement('div');
      placeholder.className = 'drop-placeholder';
      placeholder.style.height = rect.height + 'px';
      card.after(placeholder);
      card.classList.add('is-drag-source');

      drag = {
        card, overlay, placeholder,
        offsetX: pending.x - rect.left,
        offsetY: pending.y - rect.top,
        originParent: card.parentElement,
        originNext: placeholder.nextElementSibling,
        originPrevId: prevCardId(placeholder),
        originNextId: nextCardId(placeholder),
        originSection: card.closest('.column').dataset.sectionId,
      };
      pending = null;
      document.body.classList.add('is-dragging');
      window.getSelection && window.getSelection().removeAllRanges();
      update(x, y);
      rafId = requestAnimationFrame(autoScroll);
    }

    // Subtask drag: overlay is a mini card "parent title / ☐ subtask".
    function startSubtask(x, y) {
      const { card, sub } = pending;
      const cardRect = card.getBoundingClientRect();
      const subRect = sub.getBoundingClientRect();
      const overlay = document.createElement('article');
      overlay.className = 'task-card drag-overlay subtask-overlay';
      overlay.innerHTML = `<div class="so-parent"></div><div class="so-title"><span class="check-box"></span><span></span></div>`;
      overlay.querySelector('.so-parent').textContent = card.querySelector('.tc-title').textContent.trim();
      overlay.querySelector('.so-title span:last-child').textContent = sub.querySelector('.tc-sub-title').textContent.trim();
      Object.assign(overlay.style, { width: cardRect.width + 'px', left: cardRect.left + 'px', top: subRect.top - 22 + 'px' });
      document.body.appendChild(overlay);

      const placeholder = document.createElement('div');
      placeholder.className = 'drop-placeholder';
      placeholder.style.height = '64px';
      sub.classList.add('is-drag-source-sub');

      drag = {
        kind: 'subtask', card, sub, overlay, placeholder,
        offsetX: pending.x - cardRect.left,
        offsetY: pending.y - (subRect.top - 22),
        originSection: card.closest('.column').dataset.sectionId,
      };
      pending = null;
      document.body.classList.add('is-dragging');
      window.getSelection && window.getSelection().removeAllRanges();
      update(x, y);
      rafId = requestAnimationFrame(autoScroll);
    }

    function closestColumn(x) {
      let best = null;
      let bestDist = Infinity;
      for (const col of columns()) {
        const r = col.getBoundingClientRect();
        const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (dist < bestDist) { bestDist = dist; best = col; }
      }
      return best;
    }

    function update(x, y) {
      const { overlay, placeholder } = drag;
      overlay.style.transform = `translate(${x - drag.offsetX - parseFloat(overlay.style.left)}px, ${y - drag.offsetY - parseFloat(overlay.style.top)}px) rotate(1.5deg) scale(1.02)`;

      const column = closestColumn(x);
      if (!column) return;
      columns().forEach(c => c.classList.toggle('is-drop-target', c === column));
      if (drag.kind === 'subtask' && column.dataset.sectionId === drag.originSection) {
        // Same column = cancel (the subtask stays in its card).
        column.classList.remove('is-drop-target');
        if (placeholder.parentElement) placeholder.remove();
        return;
      }

      const body = column.querySelector('.column-body');
      const cards = Array.from(body.querySelectorAll('.task-card:not(.is-drag-source)'));
      const before = cards.find(c => {
        const r = c.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      const anchor = before || body.querySelector('.column-empty');
      if (anchor) {
        if (placeholder.nextElementSibling !== anchor || placeholder.parentElement !== body) body.insertBefore(placeholder, anchor);
      } else if (placeholder.parentElement !== body || placeholder.nextElementSibling) {
        body.appendChild(placeholder);
      }
    }

    function autoScroll() {
      if (!drag) return;
      const { x, y } = lastPointer;
      const br = board.getBoundingClientRect();
      if (x < br.left + EDGE) board.scrollLeft -= Math.ceil((br.left + EDGE - x) / 4);
      else if (x > br.right - EDGE) board.scrollLeft += Math.ceil((x - (br.right - EDGE)) / 4);
      const body = drag.placeholder.parentElement;
      if (body) {
        const r = body.getBoundingClientRect();
        if (y < r.top + EDGE && y > r.top - EDGE) body.scrollTop -= Math.ceil((r.top + EDGE - y) / 4);
        else if (y > r.bottom - EDGE && y < r.bottom + EDGE * 2) body.scrollTop += Math.ceil((y - (r.bottom - EDGE)) / 4);
      }
      update(x, y);
      rafId = requestAnimationFrame(autoScroll);
    }

    function prevCardId(el) {
      let n = el.previousElementSibling;
      while (n && !(n.classList.contains('task-card') && !n.classList.contains('is-drag-source'))) n = n.previousElementSibling;
      return n ? n.dataset.taskId : null;
    }
    function nextCardId(el) {
      let n = el.nextElementSibling;
      while (n && !(n.classList.contains('task-card') && !n.classList.contains('is-drag-source'))) n = n.nextElementSibling;
      return n ? n.dataset.taskId : null;
    }

    function end(commit) {
      cancelAnimationFrame(rafId);
      const d = drag;
      drag = null;
      document.body.classList.remove('is-dragging');
      columns().forEach(c => c.classList.remove('is-drop-target'));

      // Swallow the click that follows a drag so the drawer doesn't open.
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, true);
      setTimeout(() => document.removeEventListener('click', swallow, true), 0);

      if (d.kind === 'subtask') return endSubtask(d, commit);

      const { card, overlay, placeholder } = d;
      const column = placeholder.closest('.column');
      const sectionId = column ? column.dataset.sectionId : d.originSection;
      const beforeId = nextCardId(placeholder);
      const afterId = prevCardId(placeholder);
      const unchanged = sectionId === d.originSection && beforeId === d.originNextId && afterId === d.originPrevId;

      if (commit && column && !unchanged) placeholder.replaceWith(card);
      else placeholder.remove();
      card.classList.remove('is-drag-source');

      // Drop animation: overlay glides into the card's final slot.
      const target = card.getBoundingClientRect();
      overlay.classList.add('is-dropping');
      overlay.style.transform = `translate(${target.left - parseFloat(overlay.style.left)}px, ${target.top - parseFloat(overlay.style.top)}px)`;
      setTimeout(() => overlay.remove(), 160);

      if (!commit || !column || unchanged) return;

      const rollback = () => {
        if (d.originNext && d.originNext.parentElement === d.originParent) d.originParent.insertBefore(card, d.originNext);
        else d.originParent.insertBefore(card, d.originParent.querySelector('.column-empty'));
      };
      onDrop({ card, taskId: card.dataset.taskId, sectionId, fromSectionId: d.originSection, beforeId, afterId, rollback });
    }

    function endSubtask(d, commit) {
      const { sub, overlay, placeholder } = d;
      const column = placeholder.closest('.column');
      sub.classList.remove('is-drag-source-sub');
      if (!commit || !column) {
        placeholder.remove();
        overlay.classList.add('is-dropping');
        const r = sub.getBoundingClientRect();
        overlay.style.transform = `translate(${r.left - parseFloat(overlay.style.left)}px, ${r.top - 22 - parseFloat(overlay.style.top)}px)`;
        setTimeout(() => overlay.remove(), 160);
        return;
      }
      const beforeId = nextCardId(placeholder);
      const afterId = prevCardId(placeholder);
      const target = placeholder.getBoundingClientRect();
      overlay.classList.add('is-dropping');
      overlay.style.transform = `translate(${target.left - parseFloat(overlay.style.left)}px, ${target.top - parseFloat(overlay.style.top)}px)`;
      setTimeout(() => overlay.remove(), 160);
      placeholder.classList.add('is-pending');
      if (onSubtaskDrop) {
        onSubtaskDrop({
          sub, card: d.card, subtaskId: sub.dataset.subtaskId, taskId: d.card.dataset.taskId,
          sectionId: column.dataset.sectionId, beforeId, afterId, placeholder,
        });
      } else {
        placeholder.remove();
      }
    }

    return { isDragging: () => Boolean(drag) };
  };
})();
