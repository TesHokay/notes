// Home / My tasks: complete tasks and subtasks right from the list.
(function () {
  const wrap = document.querySelector('.home-wrap');
  if (!wrap) return;

  function syncSection(section) {
    if (!section) return;
    const n = section.querySelectorAll('.home-row').length;
    const count = section.querySelector('[data-home-count]');
    if (count) count.textContent = n || '';
    const empty = section.querySelector('.empty-state');
    if (empty) empty.hidden = n > 0;
  }

  wrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-home-toggle]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const row = btn.closest('.home-row');
    if (row.classList.contains('is-leaving')) return;
    const done = row.classList.contains('is-done') ? 0 : 1;
    const url = row.dataset.kind === 'subtask' ? `/subtasks/${row.dataset.id}` : `/tasks/${row.dataset.id}`;
    const parent = row.parentElement;
    const next = row.nextElementSibling;
    const section = row.closest('.home-section');

    row.classList.toggle('is-done', Boolean(done));
    row.classList.add('is-leaving');
    window.collapseOut(row, () => { row.remove(); syncSection(section); }, 350);
    try {
      await api.patch(url, { done });
      setTimeout(refreshLists, 450); // counters on top, after the row has collapsed
      toast(done ? 'Выполнено' : 'Возвращено в работу', undefined, {
        action: 'Отменить',
        onAction: async () => {
          try { await api.patch(url, { done: done ? 0 : 1 }); refreshLists(); } catch (err) { toast(api.errorText(err), 'error'); }
        },
      });
    } catch (err) {
      setTimeout(() => {
        row.classList.toggle('is-done', !done);
        row.classList.remove('is-leaving');
        if (!row.isConnected) parent.insertBefore(row, next && next.isConnected ? next : parent.querySelector('.empty-state'));
        syncSection(section);
      }, 380);
      toast(api.errorText(err), 'error');
    }
  });

  // ---------- Drag a row between sections to change its due date ----------
  // Pointer events (mouse + touch) from the grip; dropping into a section with data-drop-offset
  // sets the date to today + offset (keeping the time), 'none' clears it.
  const pad = n => String(n).padStart(2, '0');
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let drag = null;

  // Any section under the pointer: its own section (reorder) or one with data-drop-offset (new date).
  function sectionAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.closest('.home-section');
  }

  // Row in `card` the dragged one should go before (by pointer Y), or null = at the end.
  function rowBefore(card, y, dragged) {
    for (const r of card.querySelectorAll('.home-row')) {
      if (r === dragged) continue;
      const b = r.getBoundingClientRect();
      if (y < b.top + b.height / 2) return r;
    }
    return null;
  }

  // A thin line showing where the row will land.
  const marker = document.createElement('div');
  marker.className = 'home-drop-marker';
  function placeMarker(card, before) {
    if (!card) { marker.remove(); return; }
    card.insertBefore(marker, before || card.querySelector('.empty-state'));
  }

  function saveOrder(section) {
    const items = [...section.querySelectorAll('.home-row')].map(r => ({ kind: r.dataset.kind, id: Number(r.dataset.id) }));
    return api.post('/home/order', { items }).catch(() => {});
  }

  wrap.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-drag-handle]');
    if (!grip || e.button > 0) return;
    const row = grip.closest('.home-row');
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.classList.add('home-drag-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    row.classList.add('is-drag-source');
    drag = { row, ghost, from: row.closest('.home-section'), dx: e.clientX - rect.left, dy: e.clientY - rect.top, target: null, id: e.pointerId };
    grip.setPointerCapture(e.pointerId);
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
    drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    let target = sectionAt(e.clientX, e.clientY);
    // Another day only for rows whose date I may change, and only into sections that set a date.
    if (target && target !== drag.from && (!target.dataset.dropOffset || drag.row.querySelector('[data-can-edit="0"]'))) target = null;
    if (target !== drag.target) {
      if (drag.target) drag.target.classList.remove('is-drop-target');
      drag.target = target;
      if (drag.target && drag.target !== drag.from) drag.target.classList.add('is-drop-target');
    }
    const card = drag.target && drag.target.querySelector('.home-card');
    drag.before = card ? rowBefore(card, e.clientY, drag.row) : null;
    placeMarker(card, drag.before);
    // Auto-scroll near the window edges while dragging.
    if (e.clientY < 60) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  });

  async function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { row, ghost, from, target, before } = drag;
    drag = null;
    ghost.remove();
    marker.remove();
    row.classList.remove('is-drag-source');
    if (!target) return;
    target.classList.remove('is-drop-target');

    // Same section: just a new order (mine only).
    if (target === from) {
      const card = target.querySelector('.home-card');
      if (before !== row) card.insertBefore(row, before || card.querySelector('.empty-state'));
      saveOrder(target);
      return;
    }

    const offset = target.dataset.dropOffset;
    let date = null;
    if (offset !== 'none') {
      const now = window.crmNow ? window.crmNow() : new Date();
      date = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(offset)));
    }
    const card = target.querySelector('.home-card');
    const prevParent = row.parentElement;
    const prevNext = row.nextElementSibling;
    card.insertBefore(row, before || card.querySelector('.empty-state'));
    syncSection(from); syncSection(target);

    const url = row.dataset.kind === 'subtask' ? `/subtasks/${row.dataset.id}` : `/tasks/${row.dataset.id}`;
    try {
      await api.patch(url, { due_date: date });
      await saveOrder(target); // lands exactly where it was dropped
      const title = target.querySelector('.home-h').firstChild.textContent.trim();
      toast(date ? `Срок: ${offset === '7' ? 'через неделю' : title.toLowerCase()} — ${window.dayHint ? window.dayHint(Number(offset)) : date}` : 'Срок убран');
      window.taskEvents.changed(Number(row.dataset.linkId)); // refreshes lists here and boards elsewhere
    } catch (err) {
      prevParent.insertBefore(row, prevNext && prevNext.parentElement === prevParent ? prevNext : null);
      syncSection(from); syncSection(target);
      toast(api.errorText(err, 'Не удалось перенести'), 'error');
    }
  }
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.target) drag.target.classList.remove('is-drop-target');
    drag.target = null;
    endDrag(e);
  });

  async function refreshLists() {
    const url = new URL(location.href);
    url.searchParams.delete('task');
    url.searchParams.set('partial', 'lists');
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = (await res.text()).trim();
    const fresh = tpl.content.querySelector('#homeLists');
    const cur = document.getElementById('homeLists');
    if (fresh && cur) cur.replaceWith(fresh);
    // Owner counters (на сегодня / просрочено / без исполнителя) come along with the lists.
    const freshStats = tpl.content.querySelector('#homeStats');
    const curStats = document.getElementById('homeStats');
    if (freshStats && curStats) curStats.replaceWith(freshStats);
  }

  document.addEventListener('task:changed', refreshLists);
  document.addEventListener('task:deleted', refreshLists);
})();
