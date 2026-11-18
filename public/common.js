'use strict';

/*
 * Shared helpers for the chat and admin pages.
 * All user content is inserted as text nodes / textContent. Nothing here uses innerHTML.
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  /** h('div', {class: 'x', onclick: fn}, 'text', childNode) */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'value') el.value = value;
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /** Static SVG icons. Paths are constants, never user data. */
  const ICONS = {
    hash: 'M5 9h14M5 15h14M10 3 8 21M16 3l-2 18',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    plus: 'M12 5v14M5 12h14',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
    back: 'M15 18l-6-6 6-6',
    x: 'M18 6 6 18M6 6l12 12',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
    slash: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, size = 18) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name] || '');
    svg.append(path);
    return svg;
  }

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const apiHooks = { onUnauthenticated: null, onPasswordChangeRequired: null };

  async function api(method, url, data) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (data !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new ApiError("Can't reach the server. Check your connection.", 0, 'NETWORK');
    }
    let payload = {};
    try { payload = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new ApiError(payload.error || `Request failed (${res.status}).`, res.status, payload.code);
      if (res.status === 401 && payload.code === 'UNAUTHENTICATED' && apiHooks.onUnauthenticated) apiHooks.onUnauthenticated();
      if (payload.code === 'PASSWORD_CHANGE_REQUIRED' && apiHooks.onPasswordChangeRequired) apiHooks.onPasswordChangeRequired();
      throw err;
    }
    return payload;
  }

  function avatarClass(name) {
    let hash = 0;
    for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return 'av-' + (hash % 8);
  }

  function avatar(name, extraClass = '') {
    const initial = [...String(name || '?')][0].toUpperCase();
    return h('span', { class: `avatar ${avatarClass(name)} ${extraClass}`.trim(), 'aria-hidden': 'true' }, initial);
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const dateYearFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dayLabel(ts) {
    const today = startOfDay(Date.now());
    const day = startOfDay(ts);
    if (day === today) return 'Today';
    if (day === today - 86_400_000) return 'Yesterday';
    return new Date(ts).getFullYear() === new Date().getFullYear() ? dateFmt.format(ts) : dateYearFmt.format(ts);
  }

  function toast(message, kind = 'info') {
    let host = $('#toasts');
    if (!host) {
      host = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(host);
    }
    const el = h('div', { class: `toast toast-${kind}` }, message);
    host.append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, kind === 'error' ? 5000 : 3200);
  }

  /** Modal built on <dialog>. Returns { close, dialog, body }. */
  function openModal(title, content, { wide = false, onClose, dismissible = true } = {}) {
    const dialog = h('dialog', { class: `modal${wide ? ' modal-wide' : ''}`, 'aria-label': title });
    const close = () => {
      if (dialog.open) dialog.close();
    };
    const head = h('header', { class: 'modal-head' },
      h('h2', null, title),
      dismissible ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x')) : null,
    );
    const bodyEl = h('div', { class: 'modal-body' }, content);
    dialog.append(head, bodyEl);
    dialog.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
    dialog.addEventListener('click', (e) => { if (dismissible && e.target === dialog) close(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (onClose) onClose();
    });
    document.body.append(dialog);
    dialog.showModal();
    const focusable = bodyEl.querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
    return { close, dialog, body: bodyEl };
  }

  function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      let result = false;
      const m = openModal(title, [
        h('p', { class: 'modal-text' }, message),
        h('div', { class: 'modal-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
          h('button', {
            type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
            onclick: () => { result = true; m.close(); },
          }, confirmLabel),
        ),
      ], { onClose: () => resolve(result) });
    });
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.classList.toggle('busy', busy);
  }

  window.UI = {
    $, h, icon, api, apiHooks, ApiError, avatar, toast, openModal, confirmDialog, setBusy,
    timeFmt, fullFmt, dayLabel, startOfDay,
  };
})();
