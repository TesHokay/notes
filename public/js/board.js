/*
 * Board / list interactions: filters, DnD persistence, task completion,
 * inline subtasks on cards, quick-add, column management, scoped card refresh.
 * All mutations are optimistic with rollback + toast on failure; nothing
 * reloads the page.
 */
(function () {
  const board = document.getElementById('board');
  const completedView = board ? board.dataset.completedView === '1' : /[?&]completed=1/.test(location.search);

  // ---------- Filters (board, list, calendar) ----------
  document.querySelectorAll('[data-filter]').forEach(select => {
    select.addEventListener('change', () => {
      const url = new URL(location.href);
      if (select.value) url.searchParams.set(select.dataset.filter, select.value);
      else url.searchParams.delete(select.dataset.filter);
      url.searchParams.delete('task');
      location.href = url.toString();
    });
  });

  // ---------- Helpers ----------
  const cardEl = id => document.querySelector(`.task-card[data-task-id="${id}"]:not(.drag-overlay)`);
  const rowEl = id => document.querySelector(`.lv-row[data-task-id="${id}"]`);

  function updateCounts() {
    document.querySelectorAll('.column').forEach(col => {
      const n = col.querySelectorAll('.column-body > .task-card').length;
      const el = col.querySelector('[data-col-count]');
      if (el) el.textContent = n;
    });
  }

// Cards always show the open subtasks; the "✓ N/M" button unfolds the completed ones under them.
  // Which cards are unfolded is a per-viewer convenience only.
  const COLLAPSE_KEY = 'crm.showDoneSubs';
  function collapsedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch (e) { return new Set(); }
  }
  function saveCollapsed(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set].slice(-300))); } catch (e) { /* ignore */ }
  }
  function applyCollapsed(card) {
    if (!card) return;
    const showDone = collapsedSet().has(card.dataset.taskId);
    card.classList.toggle('show-done', showDone);
    const btn = card.querySelector('[data-toggle-card-subs]');
    if (btn) btn.setAttribute('aria-expanded', String(showDone));
  }
  document.querySelectorAll('.task-card').forEach(applyCollapsed);

  function removeCardAnimated(card) {
    card.classList.add('is-leaving');
    window.collapseOut(card, () => { card.remove(); updateCounts(); }, 250);
  }

  // Scoped invalidation: re-render just one card from the server.
  async function refreshCard(taskId) {
    const existing = cardEl(taskId);
    if (!board) return;
    let data;
    try { data = await api.get(`/tasks/${taskId}/card`); } catch (e) { return; }
    const shouldShow = completedView ? Boolean(data.done) : !data.done;
    const current = cardEl(taskId);
    if (!shouldShow) { if (current) removeCardAnimated(current); return; }

    const tpl = document.createElement('template');
    tpl.innerHTML = data.html.trim();
    const fresh = tpl.content.firstElementChild;
    if (current) {
      const col = current.closest('.column');
      if (col && col.dataset.sectionId !== String(data.section_id)) {
        current.remove();
        insertIntoColumn(fresh, data.section_id, 'bottom');
      } else {
        current.replaceWith(fresh);
      }
    } else if (!existing) {
      insertIntoColumn(fresh, data.section_id, 'bottom');
    }
    applyCollapsed(fresh);
    updateCounts();
  }
  window.refreshBoardCard = refreshCard;

  function insertIntoColumn(card, sectionId, placement) {
    const body = board && board.querySelector(`.column[data-section-id="${sectionId}"] .column-body`);
    if (!body) return false;
    if (placement === 'top') {
      const topForm = body.querySelector('.quick-add-top');
      topForm ? topForm.after(card) : body.prepend(card);
    } else {
      body.insertBefore(card, body.querySelector('.column-empty'));
    }
    return true;
  }

  document.addEventListener('task:changed', e => {
    if (board) refreshCard(e.detail.taskId);
    else if (rowEl(e.detail.taskId) || document.querySelector('.calendar')) softReloadView();
  });
  document.addEventListener('task:deleted', e => {
    const card = cardEl(e.detail.taskId);
    if (card) removeCardAnimated(card);
    const row = rowEl(e.detail.taskId);
    if (row) row.remove();
    document.querySelectorAll(`.cal-task[data-task-id="${e.detail.taskId}"]`).forEach(n => n.remove());
  });

  // List/calendar: re-fetch the page and swap only the view container.
  async function softReloadView() {
    const res = await fetch(location.pathname + location.search.replace(/([?&])task=\d+&?/, '$1'), { headers: { Accept: 'text/html' } }).catch(() => null);
    if (!res || !res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    ['.list-view', '.calendar'].forEach(sel => {
      const cur = document.querySelector(sel);
      const next = doc.querySelector(sel);
      if (cur && next) cur.replaceWith(next);
    });
  }

  // ---------- Complete / reopen task (card + list row) ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-toggle-done]');
    if (!btn || btn.closest('.drag-overlay') || btn.closest('#drawer')) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.toggleDone;
    const done = btn.dataset.done === '1' ? 0 : 1;
    const holder = btn.closest('.task-card, .lv-row');
    if (!holder || holder.classList.contains('is-leaving')) return;

    const parent = holder.parentElement;
    const next = holder.nextElementSibling;
    btn.dataset.done = String(done);
    holder.classList.toggle('is-done', Boolean(done));
    holder.classList.add('is-leaving');
    const leaveTimer = setTimeout(() => {
      window.collapseOut(holder, () => { holder.remove(); updateCounts(); });
    }, 380);

    try {
      const res = await api.patch(`/tasks/${id}`, { done });
      // Recurring task: its next occurrence was just created — show it.
      if (res && res.spawned_id) { if (board) setTimeout(() => refreshCard(res.spawned_id), 450); else setTimeout(softReloadView, 450); }
      toast(done ? (res && res.spawned_id ? 'Выполнено — следующая уже создана 🔁' : 'Задача выполнена') : 'Задача возвращена в работу', undefined, {
        action: 'Отменить',
        onAction: async () => {
          try { await api.patch(`/tasks/${id}`, { done: done ? 0 : 1 }); } catch (err) { return toast(api.errorText(err), 'error'); }
          if (board) refreshCard(id); else softReloadView();
        },
      });
      document.dispatchEvent(new CustomEvent('task:status', { detail: { taskId: Number(id), done } }));
    } catch (err) {
      clearTimeout(leaveTimer);
      btn.dataset.done = String(done ? 0 : 1);
      holder.classList.toggle('is-done', !done);
      holder.classList.remove('is-leaving', 'is-collapsing');
      holder.style.height = '';
      if (!holder.isConnected) parent.insertBefore(holder, next && next.isConnected ? next : null);
      updateCounts();
      toast(api.errorText(err), 'error');
    }
  });

  // ---------- Inline subtasks on card ----------
  document.addEventListener('click', async (e) => {
    // complete subtask from card
    const check = e.target.closest('[data-card-subtask-done]');
    if (check && !check.closest('.drag-overlay')) {
      e.preventDefault();
      e.stopPropagation(); // never opens the drawer
      const li = check.closest('.tc-sub');
      if (li.classList.contains('is-checked')) return;
      const card = li.closest('.task-card');
      const list = li.parentElement;
      const nextLi = li.nextElementSibling;
      const progress = card.querySelector('[data-progress-text]');
      const prevProgress = progress ? progress.textContent : '';
      const [doneN, totalN] = (prevProgress.match(/(\d+)\/(\d+)/) || [0, 0, 0]).slice(1).map(Number);

      li.classList.add('is-checked');
      if (progress) progress.textContent = `✓ ${doneN + 1}/${totalN}`;
      const progressBtn = card.querySelector('.tc-progress');
      if (progressBtn && doneN + 1 === totalN) progressBtn.classList.add('all-done');
      window.collapseOut(li, () => { li.remove(); }, 300);

      try {
        const res = await api.patch(`/subtasks/${check.dataset.cardSubtaskDone}`, { done: 1 });
        if (progress) progress.textContent = `✓ ${res.counts.done}/${res.counts.total}`;
        // Re-render after the animation: the subtask moves into «Выполнено», a hidden one comes in.
        setTimeout(() => refreshCard(card.dataset.taskId), 320);
      } catch (err) {
        li.classList.remove('is-checked', 'is-collapsing');
        li.style.height = '';
        if (!li.isConnected) list.insertBefore(li, nextLi && nextLi.isConnected ? nextLi : null);
        const subs = card.querySelector('[data-card-subs]');
        if (subs) subs.hidden = false;
        if (progress) progress.textContent = prevProgress;
        if (progressBtn) progressBtn.classList.toggle('all-done', doneN === totalN);
        toast(api.errorText(err), 'error');
      }
      return;
    }

    // reopen a completed subtask from the card's «Выполнено» list
    const reopen = e.target.closest('[data-card-subtask-reopen]');
    if (reopen && !reopen.closest('.drag-overlay')) {
      e.preventDefault();
      e.stopPropagation();
      const card = reopen.closest('.task-card');
      try {
        await api.patch(`/subtasks/${reopen.dataset.cardSubtaskReopen}`, { done: 0 });
        refreshCard(card.dataset.taskId);
        window.taskEvents.changed(Number(card.dataset.taskId));
      } catch (err) {
        toast(api.errorText(err), 'error');
      }
      return;
    }

    // open subtask → parent drawer focused on it
    const open = e.target.closest('[data-open-subtask]');
    if (open && !open.closest('.drag-overlay')) {
      e.preventDefault();
      e.stopPropagation();
      window.openTaskDrawer && window.openTaskDrawer(open.dataset.taskId, { focusSubtask: open.dataset.openSubtask });
      return;
    }

    // "✓ N/M": show / hide the completed subtasks on the card (not the drawer)
    const toggle = e.target.closest('[data-toggle-card-subs]');
    if (toggle && !toggle.closest('.drag-overlay')) {
      e.preventDefault();
      e.stopPropagation();
      const card = toggle.closest('.task-card');
      const set = collapsedSet();
      const id = card.dataset.taskId;
      if (set.has(id)) set.delete(id); else set.add(id);
      saveCollapsed(set);
      applyCollapsed(card);
      return;
    }

    // "+" on card → inline new subtask
    const add = e.target.closest('[data-card-add-subtask]');
    if (add && !add.closest('.drag-overlay')) {
      e.preventDefault();
      e.stopPropagation();
      const card = add.closest('.task-card');
      openCardSubtaskForm(card);
    }
  });

  function openCardSubtaskForm(card) {
    const form = card.querySelector('.tc-add-sub');
    if (!form) return;
    card.classList.remove('subs-collapsed');
    form.hidden = false;
    const input = form.querySelector('input');
    input.focus();
  }

  document.addEventListener('keydown', (e) => {
    const input = e.target.closest && e.target.closest('.tc-add-sub input');
    if (input && e.key === 'Escape') {
      e.stopPropagation();
      input.value = '';
      input.closest('form').hidden = true;
    }
  }, true);
  document.addEventListener('focusout', (e) => {
    const input = e.target.closest && e.target.closest('.tc-add-sub input');
    if (input && !input.value.trim()) setTimeout(() => { if (document.activeElement !== input) input.closest('form').hidden = true; }, 100);
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('.tc-add-sub');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    const taskId = form.dataset.cardAddSubtaskForm;
    input.disabled = true;
    try {
      await api.post(`/tasks/${taskId}/subtasks`, { title });
      await refreshCard(taskId);
      const card = cardEl(taskId);
      if (card) openCardSubtaskForm(card); // stay ready for the next one
    } catch (err) {
      input.disabled = false;
      toast(api.errorText(err, 'Не удалось добавить подзадачу'), 'error');
    }
  });

  if (!board) return;

  // ---------- Drag & drop ----------
  window.initBoardDnd(board, {
    async onDrop({ card, taskId, sectionId, fromSectionId, beforeId, afterId, rollback }) {
      card.classList.add('just-dropped');
      setTimeout(() => card.classList.remove('just-dropped'), 400);
      card.dataset.sectionId = sectionId;
      updateCounts();
      try {
        await api.post(`/tasks/${taskId}/move`, {
          section_id: Number(sectionId),
          before_id: beforeId ? Number(beforeId) : null,
          after_id: afterId ? Number(afterId) : null,
        });
        if (sectionId !== fromSectionId) document.dispatchEvent(new CustomEvent('task:moved', { detail: { taskId: Number(taskId), sectionId: Number(sectionId) } }));
      } catch (err) {
        rollback();
        card.dataset.sectionId = fromSectionId;
        updateCounts();
        toast(api.errorText(err, 'Не удалось переместить задачу'), 'error');
      }
    },

    // Subtask dragged into another column → server creates a new card with it.
    async onSubtaskDrop({ sub, card, subtaskId, taskId, sectionId, beforeId, afterId, placeholder }) {
      const list = sub.parentElement;
      const next = sub.nextElementSibling;
      sub.remove(); // optimistic: it leaves the parent card right away
      try {
        const res = await api.post(`/subtasks/${subtaskId}/split`, {
          section_id: Number(sectionId),
          before_id: beforeId ? Number(beforeId) : null,
          after_id: afterId ? Number(afterId) : null,
        });
        const tpl = document.createElement('template');
        tpl.innerHTML = res.html.trim();
        const fresh = tpl.content.firstElementChild;
        placeholder.replaceWith(fresh);
        fresh.classList.add('just-created');
        applyCollapsed(fresh);
        const parentTpl = document.createElement('template');
        parentTpl.innerHTML = res.parentHtml.trim();
        const parentCard = cardEl(taskId);
        if (parentCard) { const p = parentTpl.content.firstElementChild; parentCard.replaceWith(p); applyCollapsed(p); }
        updateCounts();
        toast(board.dataset.cardMode === 'client' ? 'Создана новая сделка клиента' : 'Подзадача вынесена в отдельную карточку');
      } catch (err) {
        placeholder.remove();
        if (list.isConnected) list.insertBefore(sub, next && next.parentElement === list ? next : null);
        toast(api.errorText(err, 'Не удалось вынести подзадачу'), 'error');
      }
    },
  });

  // ---------- Quick add (top via header "+", bottom via footer) ----------
  function showQuickAdd(form, trigger) {
    board.querySelectorAll('.quick-add-form:not([hidden])').forEach(f => { if (f !== form) hideQuickAdd(f); });
    form.hidden = false;
    if (trigger) trigger.hidden = true;
    form.querySelector('input').focus();
  }
  function hideQuickAdd(form) {
    form.hidden = true;
    form.querySelector('input').value = '';
    const trigger = form.closest('.column-footer') && form.closest('.column-footer').querySelector('[data-add-task]');
    if (trigger) trigger.hidden = false;
  }

  board.addEventListener('click', (e) => {
    const bottom = e.target.closest('[data-add-task]');
    if (bottom) return showQuickAdd(bottom.parentElement.querySelector('.quick-add-form'), bottom);
    const top = e.target.closest('[data-add-task-top]');
    if (top) return showQuickAdd(top.closest('.column').querySelector('.quick-add-top'));
  });

  board.addEventListener('keydown', (e) => {
    const form = e.target.closest('.quick-add-form[data-quick-add]');
    if (form && e.key === 'Escape') { e.stopPropagation(); hideQuickAdd(form); }
  });
  board.addEventListener('focusout', (e) => {
    const form = e.target.closest('.quick-add-form[data-quick-add]');
    if (!form) return;
    setTimeout(() => {
      if (!form.contains(document.activeElement) && !form.querySelector('input').value.trim()) hideQuickAdd(form);
    }, 120);
  });

  board.addEventListener('submit', async (e) => {
    const form = e.target.closest('.quick-add-form[data-quick-add]');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return hideQuickAdd(form);
    input.disabled = true;
    try {
      const { html } = await api.post(`/sections/${form.dataset.quickAdd}/tasks`, { title, placement: form.dataset.placement });
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const card = tpl.content.firstElementChild;
      insertIntoColumn(card, form.dataset.quickAdd, form.dataset.placement);
      card.classList.add('just-created');
      if (form.dataset.placement !== 'top') card.scrollIntoView({ block: 'nearest' });
      updateCounts();
      input.value = '';
    } catch (err) {
      toast(api.errorText(err, 'Не удалось создать'), 'error');
    } finally {
      input.disabled = false;
      input.focus();
    }
  });

  // ---------- Rename column (double-click) ----------
  board.addEventListener('dblclick', (e) => {
    const name = e.target.closest('[data-section-name]');
    if (!name || !board.querySelector('[data-delete-section]')) return;
    const original = name.textContent.trim();
    const input = document.createElement('input');
    input.className = 'col-name-input';
    input.value = original;
    input.setAttribute('aria-label', 'Название колонки');
    name.hidden = true;
    name.after(input);
    input.focus();
    input.select();
    let finished = false;
    async function finish(save) {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      input.remove();
      name.hidden = false;
      if (!save || !value || value === original) return;
      name.textContent = value;
      try {
        await api.patch(`/sections/${name.dataset.sectionName}`, { name: value });
      } catch (err) {
        name.textContent = original;
        toast(api.errorText(err), 'error');
      }
    }
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  });

  // ---------- Move column left / right ----------
  board.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-move-section]');
    if (!btn) return;
    const column = btn.closest('.column');
    const left = btn.dataset.dir === 'left';
    const neighbour = left ? column.previousElementSibling : column.nextElementSibling;
    if (!neighbour || !neighbour.classList.contains('column')) return;
    // Move right away; put it back if the server refuses.
    if (left) neighbour.before(column); else neighbour.after(column);
    btn.focus();
    try {
      await api.post(`/sections/${btn.dataset.moveSection}/move`, { direction: left ? 'left' : 'right' });
    } catch (err) {
      if (left) neighbour.after(column); else neighbour.before(column);
      toast(api.errorText(err, 'Не удалось переставить колонку'), 'error');
    }
  });

  // ---------- Delete column ----------
  board.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-section]');
    if (!btn) return;
    const column = btn.closest('.column');
    if (column.querySelector('.column-body > .task-card')) {
      toast('Сначала перенесите задачи из колонки', 'error');
      return;
    }
    if (!confirm('Удалить пустую колонку?')) return;
    try {
      await api.del(`/sections/${btn.dataset.deleteSection}`);
      column.remove();
    } catch (err) {
      const code = err.data && err.data.error;
      toast(code === 'last_section' ? 'Нельзя удалить последнюю колонку'
        : code === 'not_empty' ? 'В колонке есть задачи (возможно, скрытые фильтром)' : api.errorText(err), 'error');
    }
  });

  // ---------- Add column (inline) ----------
  const addSectionBtn = document.getElementById('addSectionBtn');
  const addSectionForm = document.getElementById('addSectionForm');
  if (addSectionBtn && addSectionForm) {
    const input = addSectionForm.querySelector('input');
    const close = () => { addSectionForm.hidden = true; addSectionBtn.hidden = false; input.value = ''; };
    addSectionBtn.addEventListener('click', () => { addSectionBtn.hidden = true; addSectionForm.hidden = false; input.focus(); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    input.addEventListener('blur', () => { if (!input.value.trim()) close(); });
    addSectionForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return close();
      try {
        const { html } = await api.post(`/spaces/${board.dataset.spaceId}/sections`, { name });
        addSectionForm.closest('.add-column').insertAdjacentHTML('beforebegin', html);
        input.value = '';
        input.focus();
      } catch (err) {
        toast(api.errorText(err, 'Не удалось добавить колонку'), 'error');
      }
    });
  }
})();
