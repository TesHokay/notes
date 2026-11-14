/*
 * Asana-style quick pickers: set due date / assignee straight from a card,
 * a subtask row, a Home row or a list row — without opening the task.
 * Triggers: <button data-qp="due|assignee" data-kind="task|subtask" data-id data-task-id ...>
 * One shared popover element; every save emits task events so the card /
 * list re-renders itself (scoped refresh).
 */
(function () {
  const USERS = window.__USERS || [];
  const TZ = window.__TZ_LABEL || '';
  const hint = n => (window.dayHint ? window.dayHint(n) : '');
  const weekday = (y, m, d) => (window.WEEKDAYS_FULL ? window.WEEKDAYS_FULL[new Date(y, m - 1, d).getDay()] + ', ' : '');
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

  let pop = null;
  let current = null; // { btn }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'qp-pop';
    pop.setAttribute('role', 'dialog');
    pop.hidden = true;
    document.body.appendChild(pop);
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    pop.addEventListener('click', e => e.stopPropagation());
    return pop;
  }

  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
  let sheetBackdrop = null;

  function place(btn) {
    if (isMobile()) {
      pop.classList.add('is-sheet');
      pop.hidden = false;
      if (!sheetBackdrop) {
        sheetBackdrop = document.createElement('div');
        sheetBackdrop.className = 'qp-sheet-backdrop';
        sheetBackdrop.addEventListener('click', (e) => { e.stopPropagation(); close(); });
        document.body.appendChild(sheetBackdrop);
      }
      sheetBackdrop.hidden = false;
      return;
    }
    pop.classList.remove('is-sheet');
    const r = btn.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    pop.hidden = false;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = '';
  }

  function close() {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    pop.innerHTML = '';
    if (sheetBackdrop) sheetBackdrop.hidden = true;
    if (current && current.btn.isConnected) current.btn.classList.remove('is-active');
    current = null;
  }
  window.closeQuickPicker = close;

  function changed(btn) {
    const taskId = Number(btn.dataset.taskId);
    window.taskEvents.changed(taskId);
    document.dispatchEvent(new CustomEvent('task:external-change', { detail: { taskId } }));
  }

  // ---------- Due date ----------
  function openDue(btn) {
    const kind = btn.dataset.kind;
    const url = kind === 'subtask' ? `/subtasks/${btn.dataset.id}` : `/tasks/${btn.dataset.id}`;
    const state = { date: btn.dataset.date || '', time: btn.dataset.time || '' };
    pop.innerHTML = `
      <div class="dt-quick">
        <button type="button" data-q="0">Сегодня <span class="dt-hint">${hint(0)}</span></button>
        <button type="button" data-q="1">Завтра <span class="dt-hint">${hint(1)}</span></button>
        <button type="button" data-q="7">Через неделю <span class="dt-hint">${hint(7)}</span></button>
        <button type="button" data-q="none">Без срока</button>
      </div>
      <div class="dt-inputs">
        <label><span>Дата</span><input type="date" data-date value="${state.date}"></label>
        <label><span>Время${TZ ? ', ' + TZ : ''} <em>необязательно</em></span><input type="time" data-time value="${state.time}"></label>
      </div>
      <div class="qp-foot"><span class="qp-preview" data-preview></span><button type="button" class="btn btn-sm btn-primary" data-done>Готово</button></div>`;
    const dateIn = pop.querySelector('[data-date]');
    const timeIn = pop.querySelector('[data-time]');
    const preview = pop.querySelector('[data-preview]');
    const show = () => {
      if (!state.date) { preview.textContent = 'Без срока'; return; }
      const [y, m, d] = state.date.split('-').map(Number);
      preview.textContent = `${weekday(y, m, d)}${d} ${MONTHS[m - 1]} ${y}` + (state.time ? `, ${state.time}${TZ ? ' ' + TZ : ''}` : '');
    };
    show();

    let saving = Promise.resolve();
    async function save() {
      const body = { due_date: state.date || null, due_time: state.date && state.time ? state.time : null };
      btn.dataset.date = state.date;
      btn.dataset.time = body.due_time || '';
      show();
      saving = saving.then(async () => {
        try {
          await api.patch(url, body);
          changed(btn);
        } catch (err) {
          toast(api.errorText(err), 'error');
        }
      });
      return saving;
    }

    pop.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.q === 'none') { state.date = ''; state.time = ''; dateIn.value = ''; timeIn.value = ''; await save(); close(); return; }
      const now = window.crmNow ? window.crmNow() : new Date();
      state.date = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(b.dataset.q)));
      dateIn.value = state.date;
      await save();
      if (!isMobile()) timeIn.focus(); // offer a time right away; "Готово" or Esc to finish
    }));
    dateIn.addEventListener('change', () => { state.date = dateIn.value; if (!state.date) { state.time = ''; timeIn.value = ''; } save(); });
    timeIn.addEventListener('change', () => {
      if (!state.date) { state.date = iso(window.crmNow ? window.crmNow() : new Date()); dateIn.value = state.date; }
      state.time = timeIn.value;
      save();
    });
    [dateIn, timeIn].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); saving.then(close); } }));
    pop.querySelector('[data-done]').addEventListener('click', () => saving.then(close));
    place(btn);
    if (!isMobile()) dateIn.focus();
  }

  // ---------- Assignee ----------
  function openAssignee(btn) {
    const kind = btn.dataset.kind;
    const selected = new Set((btn.dataset.assignees || '').split(',').filter(Boolean).map(Number));
    // Tasks and subtasks both take several people: tick / untick, "Готово" closes.
    const base = kind === 'subtask' ? '/subtasks' : '/tasks';
    pop.innerHTML = `
      <input type="text" class="qp-search" placeholder="Найти человека…" aria-label="Поиск">
      <div class="qp-list" role="listbox" aria-multiselectable="true"></div>
      <div class="qp-foot">
        ${kind === 'subtask' && selected.size ? '<button type="button" class="qp-clear" data-clear>Снять всех</button>' : '<span></span>'}
        <button type="button" class="btn btn-sm btn-primary" data-done>Готово</button>
      </div>`;
    const list = pop.querySelector('.qp-list');
    const search = pop.querySelector('.qp-search');

    function render() {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = USERS.filter(u => !q || u.name.toLowerCase().includes(q)).map(u => `
        <button type="button" class="qp-user${selected.has(u.id) ? ' is-selected' : ''}" data-user="${u.id}" role="option" aria-selected="${selected.has(u.id)}">
          <span class="avatar avatar-xs">${escapeHtml(initials(u.name))}</span>
          <span class="qp-user-name">${escapeHtml(u.name)}</span>
          <svg class="qp-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.2l2.6 2.6L12 5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`).join('') || '<div class="qp-none">Никого не нашли</div>';
    }
    render();
    search.addEventListener('input', render);
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const first = list.querySelector('[data-user]'); if (first) first.click(); }
    });

    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-user]');
      if (!b) return;
      const uid = Number(b.dataset.user);
      try {
        const on = !selected.has(uid);
        if (on) { selected.add(uid); await api.post(`${base}/${btn.dataset.id}/assignees`, { user_id: uid }); }
        else { selected.delete(uid); await api.del(`${base}/${btn.dataset.id}/assignees/${uid}`); }
        btn.dataset.assignees = [...selected].join(',');
        render();
        changed(btn);
      } catch (err) {
        toast(api.errorText(err), 'error');
      }
    });
    const clear = pop.querySelector('[data-clear]');
    if (clear) clear.addEventListener('click', async () => {
      try { await api.patch(`/subtasks/${btn.dataset.id}`, { assignee_ids: [] }); changed(btn); close(); } catch (err) { toast(api.errorText(err), 'error'); }
    });
    pop.querySelector('[data-done]').addEventListener('click', close);
    place(btn);
    if (!isMobile()) search.focus();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-qp]');
    if (btn && !btn.closest('.drag-overlay')) {
      e.preventDefault();
      e.stopPropagation(); // never opens the drawer / never toggles anything else
      if (btn.disabled) return;
      const same = current && current.btn === btn;
      close();
      if (same) return;
      ensurePop();
      current = { btn };
      btn.classList.add('is-active');
      pop.dataset.kind = btn.dataset.qp;
      if (btn.dataset.qp === 'due') openDue(btn); else openAssignee(btn);
      return;
    }
    if (pop && !pop.hidden && !pop.contains(e.target)) close();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop && !pop.hidden) { e.stopPropagation(); e.preventDefault(); close(); }
  }, true);
  window.addEventListener('resize', () => { if (!isMobile()) close(); });
  document.addEventListener('scroll', (e) => { if (pop && !pop.hidden && !pop.contains(e.target) && !isMobile()) close(); }, true);
})();
