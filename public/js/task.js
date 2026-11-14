/*
 * Task detail (drawer content / standalone page). Split into small
 * initialisers: metadata, date-time picker, assignees, subtasks, comments,
 * Sales client actions. Every change saves immediately, keeps the drawer
 * open and notifies the board via taskEvents.changed(taskId).
 */
(function () {
  function autosize(el) {
    if (!el) return;
    const fit = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
    el.addEventListener('input', fit);
    requestAnimationFrame(fit);
  }

  function localISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  function fullLabel(date, time) {
    if (!date) return 'Без срока';
    const [y, m, d] = date.split('-').map(Number);
    const tz = window.__TZ_LABEL || '';
    const wd = window.WEEKDAYS_FULL ? window.WEEKDAYS_FULL[new Date(y, m - 1, d).getDay()] + ', ' : '';
    return `${wd}${d} ${MONTHS[m - 1]} ${y}` + (time ? `, ${time}${tz ? ' ' + tz : ''}` : '');
  }
  function dueState(date, time) {
    if (!date) return '';
    const now = window.crmNow ? window.crmNow() : new Date();
    const today = localISO(now);
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (date < today || (date === today && time && time < hm)) return 'overdue';
    if (date === today) return 'today';
    return '';
  }

  // ---------- Task metadata ----------
  function initMetadata(root, ctx) {
    const title = root.querySelector('#f-title');
    autosize(title);
    if (title && !title.readOnly) {
      let original = title.value;
      title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
      title.addEventListener('blur', async () => {
        const value = title.value.replace(/\s+/g, ' ').trim();
        if (!value) { title.value = original; return; }
        if (value === original) return;
        try { await ctx.patch({ title: value }); original = value; } catch (e) { title.value = original; }
      });
    }

    const desc = root.querySelector('#f-description');
    autosize(desc);
    if (desc && !desc.readOnly) {
      let original = desc.value;
      desc.addEventListener('blur', async () => {
        if (desc.value === original) return;
        try { await ctx.patch({ description: desc.value }); original = desc.value; } catch (e) { /* toast shown */ }
      });
    }

    const project = root.querySelector('#f-project');
    if (project && !project.disabled) project.addEventListener('change', () => ctx.patch({ project_id: project.value ? Number(project.value) : null }));

    // Account ticks: own account switches this task; extra ticks → copies of the task for those accounts.
    const acc = root.querySelector('[data-acc-ticks]');
    if (acc) {
      const copyBtn = acc.querySelector('[data-acc-copy]');
      const extra = () => [...acc.querySelectorAll('input:checked')].map(i => Number(i.value)).filter(id => id !== Number(acc.dataset.own));
      const paint = () => {
        const n = extra().length;
        copyBtn.hidden = !n;
        copyBtn.textContent = `＋ Создать копии: ${n} акк.`;
      };
      acc.addEventListener('change', async (e) => {
        const box = e.target;
        const own = Number(acc.dataset.own) || null;
        try {
          if (!own && box.checked) {
            // No account yet: the first tick becomes this task's account.
            await ctx.patch({ project_id: Number(box.value) });
            acc.dataset.own = box.value;
          } else if (own && Number(box.value) === own && !box.checked) {
            await ctx.patch({ project_id: null });
            acc.dataset.own = '';
          }
        } catch (err) { box.checked = !box.checked; }
        paint();
      });
      copyBtn.addEventListener('click', async () => {
        const ids = extra();
        copyBtn.disabled = true;
        try {
          const res = await api.post(`/tasks/${acc.dataset.taskId}/copy-to-projects`, { project_ids: ids });
          toast(`Создано копий: ${res.created.length} (${res.created.map(c => c.project).join(', ')})`);
          setTimeout(() => location.reload(), 600);
        } catch (err) {
          copyBtn.disabled = false;
          toast(api.errorText(err, 'Не удалось создать копии'), 'error');
        }
      });
    }

    const repeat = root.querySelector('#f-repeat');
    if (repeat && !repeat.disabled) repeat.addEventListener('change', async () => {
      await ctx.patch({ repeat_rule: repeat.value || null });
      if (repeat.value) toast('Повтор включён: когда отметите выполненной, появится следующая');
    });

    const priority = root.querySelector('#f-priority');
    if (priority && !priority.disabled) priority.addEventListener('change', async () => {
      priority.className = `field-select prio-${priority.value}`;
      await ctx.patch({ priority: priority.value });
    });

    const section = root.querySelector('#f-section');
    if (section && !section.disabled) {
      let original = section.value;
      section.addEventListener('change', async () => {
        try {
          await api.post(`/tasks/${ctx.taskId}/move`, { section_id: Number(section.value) });
          original = section.value;
          ctx.changed();
        } catch (err) {
          section.value = original;
          toast(api.errorText(err, 'Не удалось сменить статус'), 'error');
        }
      });
    }
  }

  // ---------- Task / meeting ----------
  function initMeeting(root, ctx) {
    const sw = root.querySelector('#kindSwitch');
    const urlIn = root.querySelector('#f-meeting-url');
    const join = root.querySelector('#joinMeeting');
    const label = root.querySelector('[data-people-label]');
    const apply = (kind) => {
      root.querySelectorAll('.meeting-only').forEach(el => { el.hidden = kind !== 'meeting'; });
      if (label) label.textContent = kind === 'meeting' ? 'Участники' : 'Исполнитель';
      if (sw) sw.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
    };
    if (sw) sw.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b || b.disabled || b.classList.contains('active')) return;
      const prev = b.dataset.kind === 'meeting' ? 'task' : 'meeting';
      apply(b.dataset.kind);
      try {
        await ctx.patch({ kind: b.dataset.kind });
        if (b.dataset.kind === 'meeting') {
          toast('Созвон: участникам придёт приглашение и напоминания в Telegram');
          if (urlIn && !urlIn.value) urlIn.focus();
        }
      } catch (err) { apply(prev); }
    });
    if (urlIn && !urlIn.readOnly) {
      let original = urlIn.value;
      const save = async () => {
        let v = urlIn.value.trim();
        if (v === original) return;
        if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
        try {
          const res = await ctx.patch({ meeting_url: v || null });
          original = urlIn.value = res.meeting_url || '';
          if (join) { join.hidden = !original; join.href = original || '#'; }
        } catch (err) { urlIn.value = original; }
      };
      urlIn.addEventListener('change', save);
      urlIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); urlIn.blur(); } });
    }
  }

  // ---------- DateTimePicker ----------
  function initDateTimePicker(root, ctx) {
    const picker = root.querySelector('[data-dt-picker="task"]');
    if (!picker || picker.hasAttribute('data-disabled')) return;
    const label = picker.querySelector('[data-dt-label]');
    const dateIn = picker.querySelector('[data-dt-date]');
    const timeIn = picker.querySelector('[data-dt-time]');

    async function save(date, time) {
      const prev = { date: dateIn.defaultValue, time: timeIn.defaultValue };
      dateIn.value = date || '';
      timeIn.value = date ? (time || '') : '';
      label.textContent = fullLabel(date, timeIn.value);
      label.className = `field-value due-${dueState(date, timeIn.value)}`;
      try {
        await ctx.patch({ due_date: date || null, due_time: date && timeIn.value ? timeIn.value : null });
        dateIn.defaultValue = dateIn.value;
        timeIn.defaultValue = timeIn.value;
      } catch (e) {
        dateIn.value = prev.date; timeIn.value = prev.time;
        label.textContent = fullLabel(prev.date, prev.time);
      }
    }

    picker.addEventListener('click', (e) => {
      const q = e.target.closest('[data-dt-quick]');
      if (!q) return;
      const now = window.crmNow ? window.crmNow() : new Date();
      const plus = { today: 0, tomorrow: 1, nextweek: 7 }[q.dataset.dtQuick];
      if (plus === undefined) { save(null, null); picker.open = false; return; }
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + plus);
      save(localISO(d), timeIn.value);
      if (!timeIn.value) timeIn.focus(); else picker.open = false;
    });
    dateIn.addEventListener('change', () => save(dateIn.value, timeIn.value));
    timeIn.addEventListener('change', () => {
      if (!dateIn.value) {
        // Picking a time without a date means "today at that time".
        dateIn.value = localISO(window.crmNow ? window.crmNow() : new Date());
      }
      save(dateIn.value, timeIn.value);
    });
  }

  // ---------- Assignees ----------
  function initAssignees(root, ctx) {
    const list = root.querySelector('#assigneeList');
    const chips = root.querySelector('#assigneeChips');
    const picker = root.querySelector('#assigneePicker');
    if (!list) return;

    function renderChips() {
      chips.innerHTML = Array.from(list.querySelectorAll('[data-assignee-toggle]:checked')).map(cb => {
        const name = cb.dataset.name;
        const ini = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
        return `<span class="chip" data-chip-user="${cb.dataset.assigneeToggle}"><span class="avatar avatar-xs">${escapeHtml(ini)}</span>${escapeHtml(name)}</span>`;
      }).join('');
      const summary = picker.querySelector('summary');
      summary.textContent = chips.children.length ? 'Изменить' : 'Назначить';
    }

    list.addEventListener('change', async (e) => {
      const cb = e.target.closest('[data-assignee-toggle]');
      if (!cb) return;
      const userId = cb.dataset.assigneeToggle;
      renderChips();
      try {
        if (cb.checked) await api.post(`/tasks/${ctx.taskId}/assignees`, { user_id: Number(userId) });
        else await api.del(`/tasks/${ctx.taskId}/assignees/${userId}`);
        ctx.changed();
      } catch (err) {
        cb.checked = !cb.checked;
        renderChips();
        toast(api.errorText(err), 'error');
      }
    });
  }

  // ---------- Subtasks ----------
  function initSubtasks(root, ctx) {
    const section = root.querySelector('#subtasksSection');
    if (!section) return;
    const activeList = section.querySelector('#subtaskList');
    const doneList = section.querySelector('#subtaskDoneList');
    const doneBox = section.querySelector('#completedSubtasks');
    const doneCount = section.querySelector('[data-done-count]');
    const progress = section.querySelector('#subtaskProgress');
    const addBtn = section.querySelector('#addSubtaskBtn');
    const form = section.querySelector('#subtaskForm');
    const titleIn = form.querySelector('input[name=title]');

    function syncCounts() {
      const d = doneList.children.length;
      const total = d + activeList.children.length;
      doneCount.textContent = d;
      doneBox.hidden = d === 0;
      progress.textContent = total ? `${d}/${total}` : '';
    }

    function syncEmptyFlags(row) {
      row.querySelectorAll('[data-empty]').forEach(el => { el.dataset.empty = el.value ? '0' : '1'; });
      const date = row.querySelector('[data-subtask-due]');
      const time = row.querySelector('[data-subtask-time]');
      if (date && time) time.hidden = !date.value;
    }

    // Add: inline input, Enter creates and keeps the input ready for the next one.
    addBtn.addEventListener('click', () => { form.hidden = false; addBtn.hidden = true; titleIn.focus(); });
    function hideForm() { form.reset(); form.hidden = true; addBtn.hidden = false; }
    titleIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); hideForm(); } });
    form.addEventListener('focusout', () => setTimeout(() => {
      if (!form.contains(document.activeElement) && !titleIn.value.trim()) hideForm();
    }, 150));
    form.querySelectorAll('select, input[type=date], input[type=time]').forEach(el => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
    }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = (fd.get('title') || '').trim();
      if (!title) return;
      titleIn.value = '';
      try {
        const res = await api.post(`/tasks/${ctx.taskId}/subtasks`, {
          title,
          assignee_id: fd.get('assignee_id') ? Number(fd.get('assignee_id')) : null,
          due_date: fd.get('due_date') || null,
          due_time: fd.get('due_date') && fd.get('due_time') ? fd.get('due_time') : null,
        });
        activeList.insertAdjacentHTML('beforeend', res.html);
        syncCounts();
        ctx.changed();
      } catch (err) {
        titleIn.value = title;
        toast(api.errorText(err, 'Не удалось добавить подзадачу'), 'error');
      }
      titleIn.focus();
    });

    // Complete / reopen with a short animation, then move between lists.
    section.addEventListener('click', async (e) => {
      const check = e.target.closest('[data-toggle-subtask]');
      if (check) {
        const row = check.closest('.st-row');
        if (row.classList.contains('is-moving')) return;
        const done = !row.classList.contains('is-done');
        const fromList = row.parentElement;
        const nextSibling = row.nextElementSibling;
        row.classList.toggle('is-done', done);
        row.classList.add('is-moving');
        check.setAttribute('aria-pressed', String(done));
        window.collapseOut(row, () => {
          row.classList.remove('is-moving');
          (done ? doneList : activeList).appendChild(row);
          syncCounts();
        }, 300);
        try {
          await api.patch(`/subtasks/${check.dataset.toggleSubtask}`, { done: done ? 1 : 0 });
          ctx.changed();
        } catch (err) {
          setTimeout(() => {
            row.classList.toggle('is-done', !done);
            check.setAttribute('aria-pressed', String(!done));
            fromList.insertBefore(row, nextSibling && nextSibling.parentElement === fromList ? nextSibling : null);
            syncCounts();
          }, 340);
          toast(api.errorText(err), 'error');
        }
        return;
      }
      const del = e.target.closest('[data-delete-subtask]');
      if (del) {
        const row = del.closest('.st-row');
        const name = (row.querySelector('[data-subtask-title]') || {}).value || '';
        if (!confirm(`Удалить подзадачу «${name}»? Её можно будет восстановить из Корзины.`)) return;
        const parent = row.parentElement;
        const next = row.nextElementSibling;
        row.remove();
        syncCounts();
        try {
          await api.del(`/subtasks/${del.dataset.deleteSubtask}`);
          ctx.changed();
        } catch (err) {
          parent.insertBefore(row, next);
          syncCounts();
          toast(api.errorText(err, 'Не удалось удалить'), 'error');
        }
      }
    });

    // Inline edits of title / assignee / due.
    section.addEventListener('keydown', (e) => {
      if (e.target.matches('[data-subtask-title]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    section.addEventListener('focusin', (e) => {
      if (e.target.matches('[data-subtask-title]')) e.target.dataset.original = e.target.value;
    });
    section.addEventListener('focusout', async (e) => {
      const input = e.target;
      if (!input.matches('[data-subtask-title]')) return;
      const value = input.value.trim();
      if (!value) { input.value = input.dataset.original; return; }
      if (value === input.dataset.original) return;
      try { await api.patch(`/subtasks/${input.dataset.subtaskTitle}`, { title: value }); ctx.changed(); } catch (err) {
        input.value = input.dataset.original;
        toast(api.errorText(err), 'error');
      }
    });
    section.addEventListener('change', async (e) => {
      const el = e.target;
      let id; let body;
      if (el.matches('[data-subtask-assignee]')) { id = el.dataset.subtaskAssignee; body = { assignee_id: el.value ? Number(el.value) : null }; }
      else if (el.matches('[data-subtask-due]')) { id = el.dataset.subtaskDue; body = { due_date: el.value || null }; }
      else if (el.matches('[data-subtask-time]')) { id = el.dataset.subtaskTime; body = { due_time: el.value || null }; }
      else return;
      const row = el.closest('.st-row');
      if (row) syncEmptyFlags(row);
      try { await api.patch(`/subtasks/${id}`, body); ctx.changed(); } catch (err) { toast(api.errorText(err), 'error'); }
    });

    // Opened from a card subtask → scroll to it and highlight.
    const focusId = root.dataset.focusSubtask;
    if (focusId) {
      const row = section.querySelector(`.st-row[data-subtask-id="${focusId}"]`);
      if (row) {
        if (row.closest('#completedSubtasks')) doneBox.open = true;
        requestAnimationFrame(() => {
          row.scrollIntoView({ block: 'center' });
          row.classList.add('is-focused');
          setTimeout(() => row.classList.remove('is-focused'), 1600);
        });
      }
    }
  }

  // ---------- Comments ----------
  function initComments(root, ctx) {
    const form = root.querySelector('#commentForm');
    if (!form) return;
    const list = root.querySelector('#commentList');
    const count = root.querySelector('#commentCount');
    const textarea = form.querySelector('textarea');
    autosize(textarea);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = textarea.value.trim();
      if (!body) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const { comment } = await api.post(`/tasks/${ctx.taskId}/comments`, { body });
        const ini = comment.author_name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
        list.insertAdjacentHTML('beforeend', `<div class="comment"><span class="avatar avatar-sm">${escapeHtml(ini)}</span><div><div class="comment-meta"><b>${escapeHtml(comment.author_name)}</b> · ${escapeHtml(comment.when)}</div><div class="comment-body">${escapeHtml(comment.body)}</div></div></div>`);
        count.textContent = list.children.length;
        textarea.value = '';
        textarea.style.height = 'auto';
        ctx.changed();
      } catch (err) {
        toast(api.errorText(err, 'Не удалось отправить'), 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- Sales client quick actions ----------
  function initClientPanel(root, ctx) {
    const panel = root.querySelector('#clientPanel');
    if (!panel) return;
    const clientId = panel.dataset.clientId;

    async function run(url, body, okText) {
      try {
        await api.post(url, body);
        toast(okText);
        ctx.changed();
        window.reloadTaskDrawer ? window.reloadTaskDrawer() : location.reload();
      } catch (err) {
        toast(api.errorText(err), 'error');
      }
    }

    panel.querySelectorAll('[data-followup]').forEach(btn => btn.addEventListener('click', () =>
      run(`/clients/${clientId}/follow-up`, { preset: btn.dataset.followup }, 'Follow-up назначен')));

    const customBtn = panel.querySelector('#followupCustomBtn');
    const customForm = panel.querySelector('#followupCustomForm');
    customBtn.addEventListener('click', () => { customForm.hidden = !customForm.hidden; });
    customForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(customForm);
      run(`/clients/${clientId}/follow-up`, { preset: 'custom', custom_date: fd.get('custom_date'), custom_time: fd.get('custom_time') }, 'Follow-up назначен');
    });

    panel.querySelector('#holdForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      run(`/clients/${clientId}/hold`, { reason: fd.get('reason'), preset: fd.get('preset') }, 'Клиент на hold');
    });

    panel.querySelector('#logContactForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      run(`/clients/${clientId}/log-contact`, {
        summary: fd.get('summary'), outcome: fd.get('outcome'), next_action: fd.get('next_action'),
        next_date: fd.get('next_date'), next_time: fd.get('next_time'), task_id: Number(ctx.taskId),
      }, 'Контакт зафиксирован');
    });
  }

  // ---------- Complete / delete task ----------
  function initTaskActions(root, ctx) {
    const doneBtn = root.querySelector('#doneBtn');
    if (doneBtn) doneBtn.addEventListener('click', async () => {
      const done = doneBtn.dataset.done === '1' ? 0 : 1;
      const apply = (v) => {
        doneBtn.dataset.done = String(v);
        doneBtn.classList.toggle('is-done', Boolean(v));
        doneBtn.setAttribute('aria-pressed', String(Boolean(v)));
        doneBtn.querySelector('span').textContent = v ? 'Выполнено' : 'Отметить выполненной';
      };
      apply(done);
      try {
        await api.patch(`/tasks/${ctx.taskId}`, { done });
        toast(done ? 'Задача выполнена' : 'Возвращена в работу');
        ctx.changed();
      } catch (err) {
        apply(done ? 0 : 1);
        toast(api.errorText(err), 'error');
      }
    });

    const deleteBtn = root.querySelector('#deleteTaskBtn');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm('Удалить задачу? Она будет лежать в Корзине 30 дней — оттуда можно восстановить.')) return;
      try {
        await api.del(`/tasks/${ctx.taskId}`);
        window.taskEvents.deleted(ctx.taskId);
        if (window.closeTaskDrawer && document.getElementById('drawer')) window.closeTaskDrawer();
        else location.href = '/';
      } catch (err) {
        toast(api.errorText(err, 'Не удалось удалить'), 'error');
      }
    });

    // Standalone page: the close button just goes home.
    if (!document.getElementById('drawer')) {
      root.querySelectorAll('[data-drawer-close]').forEach(b => b.addEventListener('click', () => { location.href = '/'; }));
    }
  }

  window.initTaskPage = function (root) {
    root = root || document.getElementById('taskForm');
    if (!root || root.dataset.inited) return;
    root.dataset.inited = '1';
    const taskId = root.dataset.taskId;

    // Batch change notifications so a burst of edits refreshes the card once.
    let notifyTimer = null;
    const ctx = {
      taskId,
      changed() {
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(() => window.taskEvents.changed(taskId), 120);
      },
      async patch(fields) {
        try {
          const res = await api.patch(`/tasks/${taskId}`, fields);
          ctx.changed();
          return res;
        } catch (err) {
          toast(api.errorText(err), 'error');
          throw err;
        }
      },
    };

    initTaskActions(root, ctx);
    initMetadata(root, ctx);
    initMeeting(root, ctx);
    initDateTimePicker(root, ctx);
    initAssignees(root, ctx);
    initSubtasks(root, ctx);
    initComments(root, ctx);
    initClientPanel(root, ctx);
  };
})();
