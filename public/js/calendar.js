/*
 * Space calendar (content plan): "+" in a day creates a task on that date — what, which
 * account (= project of the space), who's responsible, optional time. Drag a task to another
 * day to move it. Everything refreshes the calendar in place.
 */
(function () {
  const root = () => document.getElementById('calendar');
  if (!root()) return;

  const USERS = window.__USERS || [];
  const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

  // ---------- refresh just the calendar ----------
  let refreshTimer;
  async function refresh() {
    const url = new URL(location.href);
    url.searchParams.delete('task');
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = await res.text();
    const fresh = tpl.content.getElementById('calendar');
    const cur = root();
    if (fresh && cur) cur.replaceWith(fresh);
  }
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 200); };
  document.addEventListener('task:changed', refreshSoon);
  document.addEventListener('task:deleted', refreshSoon);

  // ---------- "+" popover ----------
  let pop = null;
  let backdrop = null;
  function close() {
    if (pop) { pop.remove(); pop = null; }
    if (backdrop) { backdrop.remove(); backdrop = null; }
  }

  function open(btn) {
    close();
    const cal = root();
    const date = btn.dataset.calAdd;
    const projects = JSON.parse(cal.dataset.projects || '[]');
    const preset = Number(cal.dataset.projectFilter) || '';
    const canManage = cal.dataset.canManage === '1';
    const [y, m, d] = date.split('-').map(Number);
    const dayLabel = `${(window.WEEKDAYS_FULL || [])[new Date(y, m - 1, d).getDay()] || ''}, ${d}.${String(m).padStart(2, '0')}`;

    pop = document.createElement('div');
    pop.className = 'qp-pop cal-pop';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML = `
      <form class="cal-form">
        <div class="cal-form-head">Добавить на <b>${esc(dayLabel)}</b></div>
        <input type="text" name="title" placeholder="Что выкладываем / делаем?" required autocomplete="off" aria-label="Название">
        <label class="cal-form-label">Аккаунты <em>— на каждый отмеченный будет своя задача</em></label>
        <div class="cal-people cal-accounts" data-accounts>
          ${projects.map(p => `<label class="cal-person"><input type="checkbox" name="projects" value="${p.id}" ${p.id === preset ? 'checked' : ''}><span class="cal-acc-dot acc-${p.id % 8}"></span>${esc(p.name)}${p.people ? `<span class="cal-acc-people">→ ${esc(p.people)}</span>` : ''}</label>`).join('')}
          ${projects.length ? '' : '<span class="lv-muted" style="font-size:12px;">Аккаунтов пока нет</span>'}
        </div>
        ${canManage ? `<div style="display:flex; gap:4px; align-items:center;"><button type="button" class="btn btn-sm btn-ghost cal-new-acc" data-new-account>+ Новый аккаунт</button><a class="btn btn-sm btn-ghost" href="/spaces/${cal.dataset.spaceId}/settings#projects" title="Переименовать, удалить, ответственные по умолчанию">⚙ Аккаунты</a></div>` : ''}
        <label class="cal-form-label">Ответственные <em>— если не отметить, у каждого аккаунта свои (→)</em></label>
        <div class="cal-people">
          ${USERS.map(u => `<label class="cal-person"><input type="checkbox" name="people" value="${u.id}"><span class="avatar avatar-xs">${esc(initials(u.name))}</span>${esc(u.name)}</label>`).join('')}
        </div>
        <label class="cal-form-label">Время <em>необязательно${window.__TZ_LABEL ? ', ' + esc(window.__TZ_LABEL) : ''}</em></label>
        <input type="time" name="time" aria-label="Время">
        <div class="qp-foot">
          <button type="button" class="btn btn-sm btn-ghost" data-cancel>Отмена</button>
          <button type="submit" class="btn btn-sm btn-primary">Добавить</button>
        </div>
      </form>`;
    document.body.appendChild(pop);

    if (isMobile()) {
      pop.classList.add('is-sheet');
      backdrop = document.createElement('div');
      backdrop.className = 'qp-sheet-backdrop';
      backdrop.addEventListener('click', close);
      document.body.appendChild(backdrop);
    } else {
      const r = btn.getBoundingClientRect();
      const pw = pop.offsetWidth; const ph = pop.offsetHeight;
      let left = Math.min(r.left, window.innerWidth - pw - 8);
      let top = r.bottom + 4;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
      pop.style.left = Math.max(8, left) + 'px';
      pop.style.top = top + 'px';
    }

    const form = pop.querySelector('form');
    form.querySelector('[name=title]').focus();
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    form.querySelector('[data-cancel]').addEventListener('click', close);

    // New account right from the form — created, added to the list and ticked.
    const newBtn = form.querySelector('[data-new-account]');
    if (newBtn) newBtn.addEventListener('click', async () => {
      const name = (prompt('Название нового аккаунта (например: «Агентство», «Никита»)') || '').trim();
      if (!name) return;
      try {
        const p = await api.post(`/spaces/${cal.dataset.spaceId}/projects`, { name });
        const list = form.querySelector('[data-accounts]');
        const empty = list.querySelector('.lv-muted');
        if (empty) empty.remove();
        list.insertAdjacentHTML('beforeend', `<label class="cal-person"><input type="checkbox" name="projects" value="${p.id}" checked><span class="cal-acc-dot acc-${p.id % 8}"></span>${esc(p.name)}</label>`);
        projects.push(p);
        root().dataset.projects = JSON.stringify(projects);
      } catch (err) {
        toast(api.errorText(err), 'error');
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      if (!title) return;
      // One task per ticked account (or one without an account if none is ticked).
      const accounts = fd.getAll('projects').map(Number);
      const targets = accounts.length ? accounts : [null];
      const btnSubmit = form.querySelector('[type=submit]');
      btnSubmit.disabled = true;
      try {
        for (const projectId of targets) {
          await api.post(`/sections/${cal.dataset.sectionId}/tasks`, {
            title,
            due_date: date,
            due_time: fd.get('time') || null,
            project_id: projectId,
            assignee_ids: fd.getAll('people').map(Number),
          });
        }
        close();
        toast(targets.length > 1 ? `Добавлено на ${targets.length} аккаунта(ов)` : 'Добавлено');
        refresh();
      } catch (err) {
        btnSubmit.disabled = false;
        toast(api.errorText(err, 'Не удалось добавить'), 'error');
      }
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cal-add]');
    if (btn) { e.preventDefault(); e.stopPropagation(); open(btn); return; }
    if (pop && !pop.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    // Calendar items are focusable divs: Enter opens the task like a link.
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('cal-task')) e.target.click();
  });

  // ---------- drag a task to another day ----------
  let dragId = null;
  document.addEventListener('dragstart', (e) => {
    const a = e.target.closest && e.target.closest('#calendar .cal-task[draggable="true"]');
    if (!a) return;
    dragId = a.dataset.taskId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    a.classList.add('is-dragging');
  });
  document.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('#calendar .is-dragging, #calendar .is-drop').forEach(el => el.classList.remove('is-dragging', 'is-drop'));
  });
  document.addEventListener('dragover', (e) => {
    const day = dragId && e.target.closest && e.target.closest('#calendar .cal-day');
    if (!day) return;
    e.preventDefault();
    document.querySelectorAll('#calendar .cal-day.is-drop').forEach(el => { if (el !== day) el.classList.remove('is-drop'); });
    day.classList.add('is-drop');
  });
  document.addEventListener('drop', async (e) => {
    const day = dragId && e.target.closest && e.target.closest('#calendar .cal-day');
    if (!day) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    const a = document.querySelector(`#calendar .cal-task[data-task-id="${id}"]`);
    if (a && a.closest('.cal-day') === day) return;
    if (a) day.appendChild(a); // instant feedback
    try {
      await api.patch(`/tasks/${id}`, { due_date: day.dataset.date });
      window.taskEvents.changed(Number(id));
    } catch (err) {
      toast(api.errorText(err, 'Не удалось перенести'), 'error');
      refresh();
    }
  });
})();
