// Small shared client helpers: JSON requests, HTML escaping, task change events.
(function () {
  async function request(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      const e = new Error('network');
      e.cause = err;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `http_${res.status}`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  window.api = {
    get: url => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
    patch: (url, body) => request('PATCH', url, body || {}),
    del: url => request('DELETE', url),
    errorText(err, fallback) {
      if (err && err.message === 'network') return 'Нет связи с сервером';
      if (err && err.status === 403) return 'Недостаточно прав';
      return fallback || 'Не удалось сохранить';
    },
  };

  window.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Cross-component sync: the drawer announces changes, the board / home
  // re-render only the affected card or list (scoped invalidation).
  window.taskEvents = {
    changed(taskId) { document.dispatchEvent(new CustomEvent('task:changed', { detail: { taskId: Number(taskId) } })); },
    deleted(taskId) { document.dispatchEvent(new CustomEvent('task:deleted', { detail: { taskId: Number(taskId) } })); },
  };

  // Smoothly collapse an element (height → 0), then run `done`.
  window.collapseOut = function (el, done, delay) {
    setTimeout(() => {
      const h = el.getBoundingClientRect().height;
      el.style.height = h + 'px';
      el.style.overflow = 'hidden';
      el.getBoundingClientRect(); // reflow
      el.classList.add('is-collapsing');
      el.style.height = '0px';
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        el.style.height = '';
        el.style.overflow = '';
        el.classList.remove('is-collapsing');
        done && done();
      };
      el.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 320);
    }, delay || 0);
  };
})();
