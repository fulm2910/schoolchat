'use strict';

(function () {
  const { $, h, api, avatar, toast, openModal, confirmDialog, setBusy, fullFmt } = window.UI;

  let me = null;
  let reportStatus = 'open';

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function showTab(name) {
    for (const tab of document.querySelectorAll('.admin-tab')) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.admin-panel')) panel.hidden = panel.id !== `panel-${name}`;
    if (name === 'reports') loadReports();
    if (name === 'users') loadUsers();
    if (name === 'filter') loadFilter();
  }

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  async function loadReports() {
    const host = $('#reports');
    host.replaceChildren(h('p', { class: 'muted pad' }, 'Loading…'));
    try {
      const { reports } = await api('GET', `/api/admin/reports?status=${reportStatus}`);
      if (reportStatus === 'open') $('#report-count').textContent = reports.length ? String(reports.length) : '';
      if (!reports.length) {
        host.replaceChildren(h('div', { class: 'admin-empty' },
          h('h3', null, reportStatus === 'open' ? 'All clear' : 'Nothing here'),
          h('p', { class: 'muted' }, reportStatus === 'open' ? 'There are no open reports.' : `No ${reportStatus} reports yet.`)));
        return;
      }
      host.replaceChildren(...reports.map(reportCard));
    } catch (err) {
      host.replaceChildren(h('p', { class: 'form-error' }, err.message));
    }
  }

  function reportCard(r) {
    const where = r.conversationType === 'room' ? `#${r.conversationName}`
      : r.conversationType === 'group' ? `Group: ${r.conversationName}` : `DM: ${r.conversationName}`;

    const context = h('div', { class: 'context' }, r.context.map((m) => h('div', {
      class: `ctx-msg${m.reported ? ' reported' : ''}${m.deleted ? ' deleted' : ''}`,
    },
    avatar(m.username),
    h('div', { class: 'ctx-main' },
      h('div', { class: 'ctx-head' },
        h('strong', null, m.username),
        h('time', { class: 'muted' }, fullFmt.format(m.createdAt)),
        m.reported ? h('span', { class: 'tag tag-accent' }, 'reported') : null,
        m.deleted ? h('span', { class: 'tag' }, 'deleted') : null),
      h('div', { class: 'ctx-body' }, m.body)),
    )));

    const actions = h('div', { class: 'report-actions' });
    if (r.status === 'open') {
      if (!r.messageDeleted) {
        actions.append(h('button', {
          type: 'button', class: 'btn btn-danger small',
          onclick: async (e) => {
            setBusy(e.currentTarget, true);
            try {
              await api('DELETE', `/api/messages/${r.messageId}`);
              toast('Message deleted and report resolved.', 'success');
              loadReports();
            } catch (err) { toast(err.message, 'error'); setBusy(e.currentTarget, false); }
          },
        }, 'Delete message'));
      } else {
        actions.append(h('button', { type: 'button', class: 'btn btn-primary small', onclick: () => resolve(r.id, 'resolved') }, 'Mark resolved'));
      }
      if (!r.authorBanned && r.authorId !== me.id) {
        actions.append(h('button', {
          type: 'button', class: 'btn btn-danger-ghost small',
          onclick: async () => {
            if (await banUser({ id: r.authorId, username: r.authorName })) loadReports();
          },
        }, `Ban ${r.authorName}`));
      }
      actions.append(h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => resolve(r.id, 'dismissed') }, 'Dismiss'));
    }

    return h('article', { class: 'report-card' },
      h('header', { class: 'report-head' },
        h('div', null,
          h('div', { class: 'report-title' }, h('strong', null, r.reporterName), ' reported ', h('strong', null, r.authorName),
            r.authorBanned ? h('span', { class: 'tag tag-danger' }, 'banned') : null),
          h('div', { class: 'muted small-text' }, `${where} · ${fullFmt.format(r.createdAt)}`)),
        h('span', { class: `status status-${r.status}` }, r.status)),
      r.reason ? h('blockquote', { class: 'quote' }, r.reason) : h('p', { class: 'muted small-text' }, 'No reason given.'),
      context,
      actions.childNodes.length ? actions : null,
    );
  }

  async function resolve(id, status) {
    try {
      await api('POST', `/api/admin/reports/${id}/resolve`, { status });
      toast(status === 'dismissed' ? 'Report dismissed.' : 'Report resolved.', 'success');
      loadReports();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  let userTimer = null;
  async function loadUsers() {
    const q = $('#user-filter').value.trim();
    const body = $('#users');
    try {
      const { users } = await api('GET', `/api/admin/users?q=${encodeURIComponent(q)}`);
      if (!users.length) {
        body.replaceChildren(h('tr', null, h('td', { colspan: '5', class: 'muted pad' }, 'No users found.')));
        return;
      }
      body.replaceChildren(...users.map(userRow));
    } catch (err) {
      body.replaceChildren(h('tr', null, h('td', { colspan: '5' }, h('p', { class: 'form-error' }, err.message))));
    }
  }

  function userRow(u) {
    const tags = [];
    if (u.isAdmin) tags.push(h('span', { class: 'tag tag-accent' }, 'admin'));
    if (u.isBanned) tags.push(h('span', { class: 'tag tag-danger' }, 'banned'));
    if (u.mustChangePassword) tags.push(h('span', { class: 'tag' }, 'temp password'));
    if (u.online) tags.push(h('span', { class: 'tag tag-online' }, 'online'));
    if (!tags.length) tags.push(h('span', { class: 'muted' }, 'active'));

    const self = u.id === me.id;
    const actions = [];
    if (!self) {
      actions.push(u.isBanned
        ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => unbanUser(u) }, 'Unban')
        : h('button', { type: 'button', class: 'btn btn-danger-ghost small', onclick: async () => { if (await banUser(u)) loadUsers(); } }, 'Ban'));
      actions.push(h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => resetPassword(u) }, 'Reset password'));
      if (!u.isAdmin && !u.isBanned) actions.push(h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => promote(u) }, 'Make admin'));
    } else {
      actions.push(h('span', { class: 'muted small-text' }, 'This is you'));
    }

    return h('tr', null,
      h('td', null, h('div', { class: 'user-cell' }, avatar(u.username), h('span', null, u.username))),
      h('td', null, h('div', { class: 'tags' }, tags)),
      h('td', { class: 'num' }, String(u.messageCount)),
      h('td', { class: 'muted nowrap' }, new Date(u.createdAt).toLocaleDateString()),
      h('td', { class: 'right' }, h('div', { class: 'row-actions' }, actions)),
    );
  }

  async function banUser(u) {
    const ok = await confirmDialog(`Ban ${u.username}?`,
      `${u.username} will be signed out everywhere and won't be able to log in until unbanned. Their messages stay unless you delete them.`,
      { confirmLabel: 'Ban', danger: true });
    if (!ok) return false;
    try {
      await api('POST', `/api/admin/users/${u.id}/ban`);
      toast(`${u.username} is banned.`, 'success');
      return true;
    } catch (err) { toast(err.message, 'error'); return false; }
  }

  async function unbanUser(u) {
    try {
      await api('POST', `/api/admin/users/${u.id}/unban`);
      toast(`${u.username} is unbanned.`, 'success');
      loadUsers();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function promote(u) {
    const ok = await confirmDialog(`Make ${u.username} an admin?`,
      'Admins can read reported messages, delete any message, ban users, reset passwords and edit the word filter.',
      { confirmLabel: 'Make admin' });
    if (!ok) return;
    try {
      await api('POST', `/api/admin/users/${u.id}/promote`);
      toast(`${u.username} is now an admin.`, 'success');
      loadUsers();
    } catch (err) { toast(err.message, 'error'); }
  }

  function generatePassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint32Array(14);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  }

  function resetPassword(u) {
    const input = h('input', { class: 'input mono', maxlength: '72', autocomplete: 'off', spellcheck: 'false', value: generatePassword() });
    const err = h('p', { class: 'form-error', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Set temporary password');
    const form = h('form', { class: 'form', novalidate: true },
      h('p', { class: 'modal-text' }, `${u.username} will be signed out everywhere and must choose a new password the next time they log in. Share the temporary password with them privately.`),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Temporary password'),
        h('div', { class: 'input-row' }, input,
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { input.value = generatePassword(); } }, 'Generate'))),
      err,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit),
    );
    const modal = openModal(`Reset password for ${u.username}`, form, { wide: true });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      setBusy(submit, true);
      try {
        await api('POST', `/api/admin/users/${u.id}/reset-password`, { password: input.value });
        modal.close();
        toast(`Temporary password set for ${u.username}.`, 'success');
        loadUsers();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        setBusy(submit, false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Word filter
  // ---------------------------------------------------------------------------

  async function loadFilter() {
    const list = $('#filter-words');
    try {
      const { words } = await api('GET', '/api/admin/filter');
      list.replaceChildren(...(words.length ? words.map((w) => h('li', { class: 'word' },
        h('span', null, w.word),
        h('button', {
          type: 'button', class: 'chip-x', 'aria-label': `Remove ${w.word}`,
          onclick: async () => {
            try { await api('DELETE', `/api/admin/filter/${w.id}`); loadFilter(); } catch (err) { toast(err.message, 'error'); }
          },
        }, window.UI.icon('x', 12)),
      )) : [h('li', { class: 'muted' }, 'The list is empty. Nothing is being filtered.')]));
    } catch (err) {
      list.replaceChildren(h('li', { class: 'form-error' }, err.message));
    }
  }

  function wireFilter() {
    const form = $('#filter-form');
    const err = $('#filter-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const btn = form.querySelector('button');
      setBusy(btn, true);
      try {
        await api('POST', '/api/admin/filter', { word: form.word.value });
        form.reset();
        loadFilter();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        setBusy(btn, false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    try {
      ({ user: me } = await api('GET', '/api/me'));
    } catch {
      location.href = '/';
      return;
    }
    if (!me.isAdmin || me.mustChangePassword) {
      $('#admin-denied').hidden = false;
      return;
    }
    $('#admin-main').hidden = false;

    for (const tab of document.querySelectorAll('.admin-tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));
    for (const btn of document.querySelectorAll('#report-status .seg-btn')) {
      btn.addEventListener('click', () => {
        reportStatus = btn.dataset.status;
        for (const b of document.querySelectorAll('#report-status .seg-btn')) b.classList.toggle('active', b === btn);
        loadReports();
      });
    }
    $('#user-filter').addEventListener('input', () => {
      clearTimeout(userTimer);
      userTimer = setTimeout(loadUsers, 200);
    });
    wireFilter();
    showTab('reports');
  }

  boot();
})();
