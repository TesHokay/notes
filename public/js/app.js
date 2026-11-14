document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
});

// Close any open popover (<details class="popover|dt-picker">) on outside click.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.popover[open], details.dt-picker[open]').forEach(d => {
    if (!d.contains(e.target)) d.open = false;
  });
});

(function () {
  let container = null;
  function getContainer() {
    if (!container || !document.body.contains(container)) {
      container = document.createElement('div');
      container.className = 'toast-container';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
    }
    return container;
  }

  // toast(message, type?, { action, onAction }?)
  window.toast = function (message, type, opts) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    let timer;
    const hide = () => {
      clearTimeout(timer);
      el.classList.remove('show');
      setTimeout(() => el.remove(), 200);
    };
    if (opts && opts.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = opts.action;
      btn.addEventListener('click', () => { hide(); opts.onAction && opts.onAction(); });
      el.appendChild(btn);
    }
    getContainer().appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    timer = setTimeout(hide, opts && opts.action ? 5000 : 3000);
  };
})();

// Mobile slide-over navigation
(function () {
  const btn = document.getElementById('navToggle');
  const backdrop = document.getElementById('navBackdrop');
  if (!btn) return;
  const wsSwitch = document.querySelector('.ws-switch');
  const set = (open) => {
    document.body.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (!open && wsSwitch) wsSwitch.open = false; // the workspace menu must not stay hanging out
  };
  btn.addEventListener('click', () => set(!document.body.classList.contains('nav-open')));
  if (backdrop) backdrop.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) set(false); });
  document.querySelectorAll('#sidebar nav a').forEach(a => a.addEventListener('click', () => set(false)));
})();

// Workspace switcher: close on a click anywhere else or Esc (desktop and phone).
(function () {
  const ws = document.querySelector('.ws-switch');
  if (!ws) return;
  document.addEventListener('click', (e) => { if (ws.open && !ws.contains(e.target)) ws.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ws.open = false; });
})();

// Sales drawer: «Агентство / Бизнес» switch on the client.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-lead-type-client] [data-lead-type]');
  if (!btn) return;
  const wrap = btn.closest('[data-lead-type-client]');
  try {
    await api.post(`/clients/${wrap.dataset.leadTypeClient}/lead-type`, { type: btn.dataset.leadType });
    wrap.querySelectorAll('[data-lead-type]').forEach(b => b.classList.toggle('active', b === btn));
    toast('Тип сохранён');
  } catch (err) {
    toast(api.errorText(err), 'error');
  }
});
