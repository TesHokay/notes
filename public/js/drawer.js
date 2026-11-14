/*
 * Right-side task drawer. The board stays visible and interactive behind it
 * (clicking another card swaps the drawer content). URL keeps ?task=ID so
 * a refresh or a shared link reopens the same task.
 */
(function () {
  const drawer = document.getElementById('drawer');
  const content = document.getElementById('drawerContent');
  const backdrop = document.getElementById('drawerBackdrop');
  if (!drawer) return;

  let currentId = null;
  let loadSeq = 0;

  function urlWithTask(taskId) {
    const url = new URL(location.href);
    if (taskId) url.searchParams.set('task', taskId); else url.searchParams.delete('task');
    return url.pathname + url.search;
  }

  function markActiveCard() {
    document.querySelectorAll('.task-card.is-open').forEach(c => c.classList.remove('is-open'));
    if (currentId) document.querySelectorAll(`.task-card[data-task-id="${currentId}"]`).forEach(c => c.classList.add('is-open'));
  }

  async function load(taskId, opts = {}) {
    const seq = ++loadSeq;
    const qs = new URLSearchParams({ partial: '1' });
    if (opts.focusSubtask) qs.set('focus_subtask', opts.focusSubtask);
    let res;
    try { res = await fetch(`/tasks/${taskId}?${qs}`, { headers: { Accept: 'text/html' } }); } catch (e) { res = null; }
    if (seq !== loadSeq) return false; // a newer open() won
    if (!res || !res.ok) {
      toast(res && res.status === 403 ? 'Нет доступа к задаче' : 'Задача не найдена', 'error');
      return false;
    }
    const keepScroll = opts.keepScroll ? drawer.scrollTop : 0;
    content.innerHTML = await res.text();
    const root = content.querySelector('#taskForm');
    if (root) window.initTaskPage(root);
    drawer.scrollTop = keepScroll;
    return true;
  }

  async function open(taskId, opts = {}) {
    taskId = Number(taskId);
    const ok = await load(taskId, opts);
    if (!ok) return;
    const wasOpen = drawer.classList.contains('open');
    currentId = taskId;
    drawer.classList.add('open');
    backdrop.classList.add('open');
    document.body.classList.add('drawer-open');
    markActiveCard();
    if (!wasOpen) drawer.focus({ preventScroll: true });
    if (opts.push !== false) history.pushState({ taskId }, '', urlWithTask(taskId));
  }

  function close(opts = {}) {
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.classList.remove('drawer-open');
    const closedId = currentId;
    currentId = null;
    markActiveCard();
    setTimeout(() => { if (!currentId) content.innerHTML = ''; }, 200);
    if (opts.push !== false) history.pushState({}, '', urlWithTask(null));
    const card = closedId && document.querySelector(`.task-card[data-task-id="${closedId}"] .tc-title`);
    if (card) card.focus({ preventScroll: true });
  }

  window.openTaskDrawer = (id, opts) => open(id, opts || {});
  window.closeTaskDrawer = () => close();
  window.reloadTaskDrawer = () => (currentId ? load(currentId, { keepScroll: true }) : null);

  document.addEventListener('click', (e) => {
    const link = e.target.closest('.drawer-link');
    if (link && !link.closest('.drag-overlay')) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new tab still works
      e.preventDefault();
      open(link.dataset.taskId, { focusSubtask: link.dataset.focusSubtask });
      return;
    }
    if (e.target.closest('[data-drawer-close]')) close();
  });

  // Whole card is clickable (except its own controls) — opens the drawer.
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.task-card');
    if (!card || card.classList.contains('drag-overlay')) return;
    if (e.target.closest('button, a, input, select, textarea, form')) return;
    open(card.dataset.taskId);
  });

  backdrop.addEventListener('click', () => close());

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawer.classList.contains('open')) return;
    const openPopover = drawer.querySelector('details.popover[open], details.dt-picker[open]');
    if (openPopover) { openPopover.open = false; return; }
    const el = document.activeElement;
    if (el && drawer.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { el.blur(); return; }
    close();
  });

  // Keep the drawer in sync when the same task changes elsewhere (e.g. its
  // subtask was checked on the card) — reload only if it's the open task.
  document.addEventListener('task:status', e => { if (e.detail.taskId === currentId) window.reloadTaskDrawer(); });
  document.addEventListener('task:external-change', e => { if (e.detail.taskId === currentId) window.reloadTaskDrawer(); });
  document.addEventListener('task:moved', e => { if (e.detail.taskId === currentId) window.reloadTaskDrawer(); });

  window.addEventListener('popstate', () => {
    const id = new URL(location.href).searchParams.get('task');
    if (id) open(id, { push: false }); else close({ push: false });
  });

  const initial = new URL(location.href).searchParams.get('task');
  if (initial) open(initial, { push: false });
})();
