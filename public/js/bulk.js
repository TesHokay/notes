/*
 * Bulk actions on a board / list: "☑ Выбрать" → tick cards (click, Shift+click for a range,
 * "все" in a column header) → bottom bar: move to a column, assign, set a date, close.
 * Also the toolbar search that filters cards/rows by text as you type.
 */
(function () {
  const toggle = document.getElementById('bulkToggle');
  const items = () => [...document.querySelectorAll('[data-selectable]')].filter(el => !el.hidden && el.offsetParent !== null);
  const selected = new Set();
  let lastIndex = -1;
  let bar = null;

  // ---------- search ----------
  const search = document.getElementById('boardSearch');
  if (search) {
    const norm = s => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');
    search.addEventListener('input', () => {
      const q = norm(search.value.trim());
      document.querySelectorAll('.task-card, .list-view .lv-row').forEach(el => {
        el.hidden = q ? !norm(el.textContent).includes(q) : false;
      });
      document.querySelectorAll('.column').forEach(col => {
        const n = col.querySelectorAll('.column-body > .task-card:not([hidden])').length;
        const c = col.querySelector('[data-col-count]');
        if (c) c.textContent = n;
      });
    });
  }

  if (!toggle) return;

  function setMode(on) {
    document.body.classList.toggle('select-mode', on);
    toggle.classList.toggle('active', on);
    toggle.textContent = on ? '✕ Отменить выбор' : '☑ Выбрать';
    if (!on) { selected.clear(); paint(); }
    renderBar();
  }

  function paint() {
    document.querySelectorAll('[data-selectable]').forEach(el => el.classList.toggle('is-selected', selected.has(el.dataset.taskId)));
  }

  function columnsOptions() {
    return [...document.querySelectorAll('.column')].map(c => `<option value="${c.dataset.sectionId}">${escapeHtml(c.querySelector('.col-name').textContent.trim())}</option>`).join('');
  }

  function renderBar() {
    const on = document.body.classList.contains('select-mode');
    if (!on) { if (bar) { bar.remove(); bar = null; } return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'bulk-bar';
      const cols = columnsOptions();
      bar.innerHTML = `
        <span class="bulk-count"></span>
        ${cols ? `<label class="bulk-field">Перенести в <select data-bulk-move><option value="">колонку…</option>${cols}</select></label>` : ''}
        <label class="bulk-field">Ответственный <select data-bulk-assign><option value="">кто…</option>${(window.__USERS || []).map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}<option value="__none">— снять всех —</option></select></label>
        ${document.querySelector('[data-lead-type-filter]') ? `<label class="bulk-field">Тип <select data-bulk-type><option value="">…</option><option value="agency">🏢 Агентство</option><option value="business">🛍 Бизнес</option><option value="none">— не указан —</option></select></label>` : ''}
        <label class="bulk-field">Срок <input type="date" data-bulk-due></label>
        <button type="button" class="btn btn-sm" data-bulk-nodue>Без срока</button>
        <button type="button" class="btn btn-sm" data-bulk-done>✓ Закрыть</button>
        <button type="button" class="btn btn-sm btn-ghost" data-bulk-all>Выбрать все</button>
        <button type="button" class="btn btn-sm btn-ghost" data-bulk-cancel>Отмена</button>`;
      document.body.appendChild(bar);
      bar.querySelector('[data-bulk-cancel]').addEventListener('click', () => setMode(false));
      bar.querySelector('[data-bulk-all]').addEventListener('click', () => { items().forEach(el => selected.add(el.dataset.taskId)); paint(); renderBar(); });
      const mv = bar.querySelector('[data-bulk-move]');
      if (mv) mv.addEventListener('change', () => { if (mv.value) run({ action: 'move', section_id: Number(mv.value) }, `Перенесено в «${mv.selectedOptions[0].text}»`); });
      const as = bar.querySelector('[data-bulk-assign]');
      as.addEventListener('change', () => {
        if (!as.value) return;
        if (as.value === '__none') run({ action: 'unassign_all' }, 'Исполнители сняты');
        else run({ action: 'assign', user_id: Number(as.value) }, `Назначено: ${as.selectedOptions[0].text}`);
      });
      const lt = bar.querySelector('[data-bulk-type]');
      if (lt) lt.addEventListener('change', () => { if (lt.value) run({ action: 'lead_type', lead_type: lt.value === 'none' ? '' : lt.value }, `Тип: ${lt.selectedOptions[0].text}`); });
      const due = bar.querySelector('[data-bulk-due]');
      due.addEventListener('change', () => { if (due.value) run({ action: 'due', due_date: due.value }, 'Срок поставлен'); });
      bar.querySelector('[data-bulk-nodue]').addEventListener('click', () => run({ action: 'due', due_date: null }, 'Срок убран'));
      bar.querySelector('[data-bulk-done]').addEventListener('click', () => {
        if (confirm(`Закрыть ${selected.size} шт.?`)) run({ action: 'done' }, 'Закрыто');
      });
    }
    const n = selected.size;
    bar.querySelector('.bulk-count').textContent = n ? `Выбрано: ${n}` : 'Отметьте карточки (Shift — диапазон)';
    bar.classList.toggle('is-empty', !n);
  }

  async function run(body, okText) {
    if (!selected.size) { toast('Сначала отметьте карточки'); renderBar(); return; }
    bar.classList.add('is-busy');
    try {
      const res = await api.post('/tasks/bulk', { ids: [...selected].map(Number), ...body });
      sessionStorage.setItem('bulk-toast', `${okText}: ${res.done}${res.skipped ? ` (пропущено ${res.skipped} — нет прав)` : ''}`);
      location.reload();
    } catch (err) {
      bar.classList.remove('is-busy');
      toast(api.errorText(err), 'error');
    }
  }

  try {
    const msg = sessionStorage.getItem('bulk-toast');
    if (msg) { sessionStorage.removeItem('bulk-toast'); setTimeout(() => toast(msg), 300); }
  } catch (e) { /* ignore */ }

  toggle.addEventListener('click', () => setMode(!document.body.classList.contains('select-mode')));

  // In select mode a click ticks instead of opening / dragging. Capture phase: runs before the drawer.
  function onPick(e) {
    if (!document.body.classList.contains('select-mode')) return;
    const colAll = e.target.closest('[data-select-column]');
    if (colAll && e.type === 'click') {
      e.preventDefault(); e.stopPropagation();
      const col = colAll.closest('.column');
      const cards = [...col.querySelectorAll('.task-card[data-selectable]:not([hidden])')];
      const allOn = cards.every(c => selected.has(c.dataset.taskId));
      cards.forEach(c => (allOn ? selected.delete(c.dataset.taskId) : selected.add(c.dataset.taskId)));
      paint(); renderBar();
      return;
    }
    const el = e.target.closest('[data-selectable]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== 'click') return;
    const list = items();
    const idx = list.indexOf(el);
    if (e.shiftKey && lastIndex !== -1 && idx !== -1) {
      const [a, b] = idx < lastIndex ? [idx, lastIndex] : [lastIndex, idx];
      list.slice(a, b + 1).forEach(x => selected.add(x.dataset.taskId));
    } else if (selected.has(el.dataset.taskId)) {
      selected.delete(el.dataset.taskId);
    } else {
      selected.add(el.dataset.taskId);
    }
    lastIndex = idx;
    paint(); renderBar();
  }
  document.addEventListener('click', onPick, true);
  document.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('select-mode') && e.target.closest('[data-selectable], [data-select-column]')) e.stopPropagation();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('select-mode')) setMode(false); });
})();
