'use strict';

(function () {
  const { $, h, icon, api, apiHooks, avatar, toast, openModal, confirmDialog, setBusy, timeFmt, fullFmt, dayLabel, startOfDay } = window.UI;

  const MAX_LEN = 2000;
  const GROUP_WINDOW_MS = 5 * 60_000;
  const TYPING_TTL_MS = 4000;

  const S = {
    me: null,
    config: { inviteRequired: false },
    convs: new Map(), // id -> conversation summary
    msgs: new Map(), // id -> { items, hasMore, loaded, loading }
    members: new Map(), // id -> [{id, username}]
    online: new Map(), // userId -> username
    typing: new Map(), // convId -> Map(userId -> { username, until })
    drafts: new Map(),
    pending: new Map(), // clientId -> { text, convId }
    activeId: null,
    ws: null,
    wsWanted: false,
    wsRetry: 0,
    hadConnection: false,
    lastTypingSent: 0,
    running: false,
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

  // -------------------------------------------------------------------------
  // Auth screens
  // -------------------------------------------------------------------------

  const authView = $('#auth-view');
  const appView = $('#app-view');
  const forms = { login: $('#login-form'), signup: $('#signup-form'), reset: $('#reset-form') };

  function formError(form, message) {
    const el = form.querySelector('.form-error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function showAuth(mode = 'login', message = '') {
    stopApp();
    appView.hidden = true;
    authView.hidden = false;
    $('#auth-tabs').hidden = mode === 'reset';
    for (const [name, form] of Object.entries(forms)) {
      form.hidden = name !== mode;
      formError(form, '');
    }
    for (const tab of document.querySelectorAll('#auth-tabs .tab')) {
      const active = tab.dataset.tab === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    if (mode === 'signup') {
      $('#invite-field').hidden = !S.config.inviteRequired;
      loadChallenge();
    }
    if (message) formError(forms[mode], message);
    const first = forms[mode].querySelector('input:not([tabindex="-1"])');
    if (first && !isMobile()) first.focus();
  }

  async function loadChallenge() {
    const q = $('#challenge-question');
    q.textContent = '…';
    try {
      const c = await api('GET', '/api/challenge');
      forms.signup.dataset.challengeId = c.id;
      q.textContent = c.question;
    } catch (err) {
      q.textContent = 'unavailable';
      formError(forms.signup, err.message);
    }
  }

  function wireAuth() {
    for (const tab of document.querySelectorAll('#auth-tabs .tab')) {
      tab.addEventListener('click', () => showAuth(tab.dataset.tab));
    }
    $('#challenge-refresh').addEventListener('click', loadChallenge);

    forms.login.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = forms.login;
      const btn = f.querySelector('button[type=submit]');
      formError(f, '');
      const username = f.username.value.trim();
      const password = f.password.value;
      if (!username || !password) return formError(f, 'Enter your username and password.');
      setBusy(btn, true);
      try {
        const { user } = await api('POST', '/api/login', { username, password });
        f.reset();
        S.me = user;
        if (user.mustChangePassword) showAuth('reset');
        else startApp();
      } catch (err) {
        formError(f, err.message);
      } finally {
        setBusy(btn, false);
      }
    });

    forms.signup.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = forms.signup;
      const btn = f.querySelector('button[type=submit]');
      formError(f, '');
      const username = f.username.value.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return formError(f, 'Usernames must be 3 to 20 characters: letters, numbers and underscores.');
      }
      const len = [...f.password.value].length;
      if (len < 8 || len > 72) return formError(f, 'Password must be 8 to 72 characters.');
      if (f.password.value !== f.confirm.value) return formError(f, "Passwords don't match.");
      if (!f.answer.value.trim()) return formError(f, 'Answer the quick check question.');
      setBusy(btn, true);
      try {
        const { user } = await api('POST', '/api/signup', {
          username,
          password: f.password.value,
          inviteCode: f.inviteCode.value,
          challengeId: f.dataset.challengeId,
          answer: f.answer.value.trim(),
          website: f.website.value,
        });
        f.reset();
        S.me = user;
        startApp();
        if (user.isAdmin) toast('Welcome! As the first member, you are the admin.', 'success');
      } catch (err) {
        formError(f, err.message);
        f.answer.value = '';
        loadChallenge();
      } finally {
        setBusy(btn, false);
      }
    });

    forms.reset.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = forms.reset;
      const btn = f.querySelector('button[type=submit]');
      formError(f, '');
      if (f.newPassword.value !== f.confirm.value) return formError(f, "Passwords don't match.");
      setBusy(btn, true);
      try {
        const { user } = await api('POST', '/api/password', {
          currentPassword: f.currentPassword.value,
          newPassword: f.newPassword.value,
        });
        f.reset();
        S.me = user;
        startApp();
        toast('Password updated.', 'success');
      } catch (err) {
        formError(f, err.message);
      } finally {
        setBusy(btn, false);
      }
    });

    $('#reset-logout').addEventListener('click', logout);
  }

  apiHooks.onUnauthenticated = () => {
    if (S.running) showAuth('login', 'Your session ended. Please log in again.');
  };
  apiHooks.onPasswordChangeRequired = () => showAuth('reset');

  // -------------------------------------------------------------------------
  // App lifecycle
  // -------------------------------------------------------------------------

  async function startApp() {
    S.running = true;
    authView.hidden = true;
    appView.hidden = false;
    renderMe();
    try {
      await loadConversations();
    } catch (err) {
      if (err.status === 401 || err.status === 403) return;
      toast(err.message, 'error');
    }
    connectWs();
    const saved = Number(store.get('schoolchat:active'));
    const fallback = [...S.convs.values()].find((c) => c.type === 'room' && c.name === 'general');
    const target = S.convs.has(saved) ? saved : fallback && fallback.id;
    if (target && !isMobile()) openConversation(target);
    else showEmpty();
  }

  function stopApp() {
    if (!S.running) return;
    S.running = false;
    S.wsWanted = false;
    if (S.ws) S.ws.close();
    S.ws = null;
    S.hadConnection = false;
    S.convs.clear();
    S.msgs.clear();
    S.members.clear();
    S.online.clear();
    S.typing.clear();
    S.pending.clear();
    S.drafts.clear();
    S.activeId = null;
    document.title = 'schoolchat';
    for (const d of document.querySelectorAll('dialog')) d.close();
  }

  async function logout() {
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    S.me = null;
    showAuth('login');
  }

  // -------------------------------------------------------------------------
  // Sidebar
  // -------------------------------------------------------------------------

  async function loadConversations() {
    const { conversations } = await api('GET', '/api/conversations');
    S.convs = new Map(conversations.map((c) => [c.id, c]));
    renderNav();
  }

  function renderMe() {
    $('#me-avatar').replaceChildren(avatar(S.me.username));
    $('#me-name').textContent = S.me.username;
    $('#me-role').textContent = S.me.isAdmin ? 'Admin' : 'Member';
    $('#me-gear').replaceChildren(icon('settings', 16));
  }

  function convIcon(conv, extra = '') {
    if (conv.type === 'dm') {
      const online = conv.otherUser && S.online.has(conv.otherUser.id);
      return h('span', { class: `nav-avatar ${extra}` }, avatar(conv.name), h('span', { class: `presence${online ? ' on' : ''}` }));
    }
    return h('span', { class: `nav-glyph ${extra}` }, icon(conv.type === 'room' ? 'hash' : 'lock', 15));
  }

  function renderNav() {
    const groups = { room: [], group: [], dm: [] };
    for (const c of S.convs.values()) groups[c.type].push(c);
    groups.room.sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
    groups.group.sort((a, b) => a.name.localeCompare(b.name));
    groups.dm.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0) || a.name.localeCompare(b.name));

    const empty = { room: 'Browse rooms to join one.', group: 'No groups yet.', dm: 'Find someone to message.' };
    let totalUnread = 0;
    for (const [type, list] of Object.entries(groups)) {
      const ul = $(`#list-${type}`);
      if (!list.length) {
        ul.replaceChildren(h('li', { class: 'nav-empty' }, empty[type]));
        continue;
      }
      ul.replaceChildren(...list.map((c) => {
        totalUnread += c.unread || 0;
        const active = c.id === S.activeId;
        return h('li', null, h('button', {
          type: 'button',
          class: `nav-item${active ? ' active' : ''}${c.unread ? ' has-unread' : ''}`,
          'aria-current': active ? 'page' : null,
          onclick: () => openConversation(c.id),
        },
        convIcon(c),
        h('span', { class: 'nav-name' }, c.name),
        c.unread ? h('span', { class: 'badge', 'aria-label': `${c.unread} unread` }, c.unread > 99 ? '99+' : String(c.unread)) : null,
        ));
      }));
    }
    document.title = totalUnread ? `(${totalUnread > 99 ? '99+' : totalUnread}) schoolchat` : 'schoolchat';
  }

  function setConn(state) {
    const el = $('#conn-status');
    el.className = `conn conn-${state}`;
    const label = { connecting: 'Connecting…', online: 'Connected', offline: 'Offline, reconnecting…' }[state];
    el.title = label;
    el.setAttribute('aria-label', label);
  }

  // People search (sidebar)
  function wireSearch() {
    const input = $('#user-search');
    const results = $('#search-results');
    let timer = null;
    let seq = 0;

    const hide = () => { results.hidden = true; results.replaceChildren(); };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) return hide();
      timer = setTimeout(async () => {
        const mine = ++seq;
        if (!/^[A-Za-z0-9_]+$/.test(q)) {
          results.replaceChildren(h('li', { class: 'search-empty' }, 'Usernames use letters, numbers and _'));
          results.hidden = false;
          return;
        }
        try {
          const { users } = await api('GET', `/api/users/search?q=${encodeURIComponent(q)}`);
          if (mine !== seq) return;
          results.replaceChildren(...(users.length ? users.map((u) => h('li', null,
            h('button', {
              type: 'button', class: 'search-item',
              onclick: () => { input.value = ''; hide(); startDm(u.username); },
            }, avatar(u.username), h('span', null, u.username), u.online ? h('span', { class: 'presence on inline' }) : null),
          )) : [h('li', { class: 'search-empty' }, 'No one by that name.')]));
          results.hidden = false;
        } catch (err) {
          if (mine === seq) toast(err.message, 'error');
        }
      }, 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; hide(); input.blur(); }
      if (e.key === 'Enter') {
        const first = results.querySelector('.search-item');
        if (first) first.click();
      }
      if (e.key === 'ArrowDown') {
        const first = results.querySelector('.search-item');
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
    results.addEventListener('keydown', (e) => {
      const items = [...results.querySelectorAll('.search-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? items[i - 1] : input).focus(); }
      if (e.key === 'Escape') { input.value = ''; hide(); input.focus(); }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search')) hide();
    });
  }

  async function startDm(username) {
    try {
      const { conversation } = await api('POST', '/api/dms', { username });
      S.convs.set(conversation.id, conversation);
      renderNav();
      openConversation(conversation.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Conversation pane
  // -------------------------------------------------------------------------

  function showEmpty() {
    S.activeId = null;
    $('#conv').hidden = true;
    $('#empty-state').hidden = false;
    appView.classList.remove('show-main');
    renderNav();
  }

  async function openConversation(id) {
    const conv = S.convs.get(id);
    if (!conv) return;
    if (S.activeId && S.activeId !== id) S.drafts.set(S.activeId, $('#composer-input').value);
    S.activeId = id;
    store.set('schoolchat:active', String(id));
    $('#empty-state').hidden = true;
    $('#conv').hidden = false;
    appView.classList.add('show-main');
    setComposerError('');
    const input = $('#composer-input');
    input.value = S.drafts.get(id) || '';
    autosize();
    updateCount();
    input.placeholder = conv.type === 'room' ? `Message #${conv.name}` : `Message ${conv.name}`;
    renderHeader();
    renderTyping();

    const st = S.msgs.get(id);
    if (st && st.loaded) {
      renderMessages('bottom');
      if (conv.unread && st.items.length) sendRead(id, st.items[st.items.length - 1].id);
      conv.unread = 0;
      renderNav();
    } else {
      $('#messages-inner').replaceChildren(h('div', { class: 'messages-loading' }, h('span', { class: 'spinner' }), 'Loading messages…'));
      renderNav();
      await loadLatest(id);
    }
    loadMembers(id);
    if (!isMobile()) input.focus();
  }

  async function loadLatest(id) {
    try {
      const { messages, hasMore } = await api('GET', `/api/conversations/${id}/messages`);
      S.msgs.set(id, { items: messages, hasMore, loaded: true, loading: false });
      const conv = S.convs.get(id);
      if (conv) conv.unread = 0;
      renderNav();
      if (S.activeId === id) renderMessages('bottom');
    } catch (err) {
      if (err.status === 403) {
        S.convs.delete(id);
        renderNav();
        if (S.activeId === id) showEmpty();
      }
      toast(err.message, 'error');
    }
  }

  async function loadOlder() {
    const id = S.activeId;
    const st = S.msgs.get(id);
    if (!st || !st.loaded || st.loading || !st.hasMore || !st.items.length) return;
    st.loading = true;
    try {
      const { messages, hasMore } = await api('GET', `/api/conversations/${id}/messages?before=${st.items[0].id}`);
      const known = new Set(st.items.map((m) => m.id));
      st.items = [...messages.filter((m) => !known.has(m.id)), ...st.items];
      st.hasMore = hasMore;
      if (S.activeId === id) renderMessages('preserve');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      st.loading = false;
    }
  }

  async function loadMembers(id) {
    try {
      const { members } = await api('GET', `/api/conversations/${id}/members`);
      S.members.set(id, members);
      const conv = S.convs.get(id);
      if (conv) conv.memberCount = members.length;
      if (S.activeId === id) renderHeader();
    } catch { /* non-critical */ }
  }

  function renderHeader() {
    const conv = S.convs.get(S.activeId);
    if (!conv) return;
    $('#btn-back').replaceChildren(icon('back', 20));
    $('#conv-icon').replaceChildren(convIcon(conv, 'large'));
    $('#conv-name').textContent = conv.type === 'room' ? conv.name : conv.name;
    $('#conv-name').classList.toggle('is-room', conv.type === 'room');
    let sub;
    if (conv.type === 'dm') {
      sub = conv.otherUser && S.online.has(conv.otherUser.id) ? 'Online' : 'Offline';
    } else {
      const members = S.members.get(conv.id);
      const count = members ? members.length : conv.memberCount;
      const online = members ? members.filter((m) => S.online.has(m.id)).length : null;
      sub = `${conv.type === 'room' ? 'Public room' : 'Private group'} · ${count} member${count === 1 ? '' : 's'}`;
      if (online != null) sub += ` · ${online} online`;
    }
    $('#conv-sub').textContent = sub;
  }

  // Message rendering ---------------------------------------------------------

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

  /** Plain text with http(s) links made clickable. Text only, never HTML. */
  function renderBody(text) {
    const out = [];
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      let url;
      try { url = new URL(match[0]); } catch { continue; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (match.index > last) out.push(text.slice(last, match.index));
      const a = h('a', { target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, match[0]);
      a.href = url.href;
      out.push(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function messageEl(m, grouped) {
    const mine = m.userId === S.me.id;
    const actions = [];
    if (!mine) {
      actions.push(h('button', { type: 'button', class: 'msg-action', title: 'Report', 'aria-label': 'Report message', onclick: () => reportMessage(m) }, icon('flag', 15)));
      actions.push(h('button', { type: 'button', class: 'msg-action', title: `Block ${m.username}`, 'aria-label': `Block ${m.username}`, onclick: () => blockUser(m.userId, m.username) }, icon('slash', 15)));
    }
    if (mine || S.me.isAdmin) {
      actions.push(h('button', { type: 'button', class: 'msg-action danger', title: 'Delete', 'aria-label': 'Delete message', onclick: () => deleteMessage(m) }, icon('trash', 15)));
    }
    const iso = new Date(m.createdAt).toISOString();
    const full = fullFmt.format(m.createdAt);
    return h('article', { class: `msg${grouped ? ' grouped' : ''}${mine ? ' mine' : ''}`, tabindex: '-1', dataset: { id: String(m.id) } },
      grouped
        ? h('time', { class: 'msg-gutter', datetime: iso, title: full }, timeFmt.format(m.createdAt))
        : avatar(m.username, 'msg-avatar'),
      h('div', { class: 'msg-main' },
        grouped ? null : h('header', { class: 'msg-head' },
          h('span', { class: 'msg-author' }, m.username),
          h('time', { class: 'msg-time', datetime: iso, title: full }, timeFmt.format(m.createdAt)),
        ),
        h('div', { class: 'msg-body' }, renderBody(m.body)),
      ),
      actions.length ? h('div', { class: 'msg-actions' }, actions) : null,
    );
  }

  function renderMessages(mode = 'auto') {
    const conv = S.convs.get(S.activeId);
    const st = S.msgs.get(S.activeId);
    if (!conv || !st) return;
    const box = $('#messages');
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

    const nodes = [];
    if (st.hasMore) {
      nodes.push(h('div', { class: 'history-more' }, h('button', { type: 'button', class: 'btn btn-ghost small', onclick: loadOlder }, 'Load older messages')));
    } else {
      const intro = conv.type === 'room'
        ? [`This is the start of #${conv.name}.`, 'Everyone who joins this room can read it.']
        : conv.type === 'group'
          ? [`This is the start of ${conv.name}.`, 'Only members of this private group can read it.']
          : [`This is the start of your conversation with ${conv.name}.`, 'Only the two of you can read it.'];
      nodes.push(h('div', { class: 'history-start' }, convIcon(conv, 'xl'), h('h3', null, intro[0]), h('p', null, intro[1])));
    }

    let prev = null;
    for (const m of st.items) {
      if (!prev || startOfDay(prev.createdAt) !== startOfDay(m.createdAt)) {
        nodes.push(h('div', { class: 'day-divider', role: 'separator' }, h('span', null, dayLabel(m.createdAt))));
        prev = null;
      }
      const grouped = prev && prev.userId === m.userId && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
      nodes.push(messageEl(m, grouped));
      prev = m;
    }
    $('#messages-inner').replaceChildren(...nodes);

    if (mode === 'bottom' || (mode === 'auto' && atBottom)) box.scrollTop = box.scrollHeight;
    else if (mode === 'preserve') box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    else box.scrollTop = prevTop;
  }

  async function deleteMessage(m) {
    const ok = await confirmDialog('Delete message?', 'This removes the message for everyone. It cannot be undone.', { confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/messages/${m.id}`);
      removeMessage(m.conversationId, m.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function removeMessage(convId, messageId) {
    const st = S.msgs.get(convId);
    if (!st) return;
    const before = st.items.length;
    st.items = st.items.filter((x) => x.id !== messageId);
    if (st.items.length !== before && S.activeId === convId) renderMessages('keep');
  }

  function reportMessage(m) {
    const reason = h('textarea', { class: 'textarea', rows: '3', maxlength: '500', placeholder: 'What is wrong with this message? (optional)' });
    const err = h('p', { class: 'form-error', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-danger' }, 'Send report');
    const preview = h('blockquote', { class: 'quote' }, h('strong', null, m.username), ' ', m.body.length > 280 ? m.body.slice(0, 280) + '…' : m.body);
    const form = h('form', { class: 'form', novalidate: true },
      preview,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Reason'), reason),
      err,
      h('p', { class: 'field-hint' }, 'Reports go to the admins. The person you report is not told who reported them.'),
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit),
    );
    const modal = openModal('Report message', form);
    reason.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setBusy(submit, true);
      try {
        await api('POST', `/api/messages/${m.id}/report`, { reason: reason.value });
        modal.close();
        toast('Thanks. An admin will take a look.', 'success');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        setBusy(submit, false);
      }
    });
  }

  async function blockUser(userId, username) {
    const ok = await confirmDialog(`Block ${username}?`,
      `You won't see messages from ${username} in rooms, groups or DMs, and they won't be able to start a DM with you. They won't be told.`,
      { confirmLabel: 'Block', danger: true });
    if (!ok) return;
    try {
      await api('POST', '/api/blocks', { userId });
      for (const [convId, st] of S.msgs) {
        st.items = st.items.filter((m) => m.userId !== userId);
        if (convId === S.activeId) renderMessages('keep');
      }
      toast(`${username} is blocked. You can unblock them from your account menu.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Typing ---------------------------------------------------------------------

  function renderTyping() {
    const el = $('#typing');
    const map = S.typing.get(S.activeId);
    const t = Date.now();
    const names = [];
    if (map) for (const [uid, v] of map) { if (v.until > t) names.push(v.username); else map.delete(uid); }
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = 'Several people are typing…';
    el.replaceChildren(...(text ? [h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), text] : []));
    el.classList.toggle('visible', !!text);
  }

  // Composer -------------------------------------------------------------------

  function autosize() {
    const input = $('#composer-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  function updateCount() {
    const len = [...$('#composer-input').value].length;
    const el = $('#char-count');
    el.textContent = len > MAX_LEN - 200 ? `${len} / ${MAX_LEN}` : '';
    el.classList.toggle('over', len > MAX_LEN);
  }

  function setComposerError(message) {
    $('#composer-error').textContent = message;
    $('#composer-hint').hidden = !!message;
  }

  function wireComposer() {
    const form = $('#composer');
    const input = $('#composer-input');
    $('#send-btn').replaceChildren(icon('send', 18));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    input.addEventListener('input', () => {
      autosize();
      updateCount();
      if ($('#composer-error').textContent) setComposerError('');
      const t = Date.now();
      if (input.value.trim() && t - S.lastTypingSent > 2500 && S.ws && S.ws.readyState === WebSocket.OPEN) {
        S.lastTypingSent = t;
        S.ws.send(JSON.stringify({ type: 'typing', conversationId: S.activeId }));
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const convId = S.activeId;
      const text = input.value;
      if (!convId || !text.trim()) return;
      if ([...text.trim()].length > MAX_LEN) return setComposerError(`Messages can be at most ${MAX_LEN} characters.`);
      input.value = '';
      S.drafts.delete(convId);
      autosize();
      updateCount();
      setComposerError('');
      S.lastTypingSent = 0;

      if (S.ws && S.ws.readyState === WebSocket.OPEN) {
        const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        S.pending.set(clientId, { text, convId });
        S.ws.send(JSON.stringify({ type: 'send', clientId, conversationId: convId, body: text }));
      } else {
        try {
          const { message } = await api('POST', `/api/conversations/${convId}/messages`, { body: text });
          onIncoming(message);
        } catch (err) {
          restoreDraft(convId, text, err.message);
        }
      }
    });
  }

  function restoreDraft(convId, text, message) {
    if (S.activeId === convId) {
      const input = $('#composer-input');
      if (!input.value) input.value = text;
      autosize();
      updateCount();
      setComposerError(message);
    } else {
      S.drafts.set(convId, text);
      toast(message, 'error');
    }
  }

  function sendRead(convId, messageId) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'read', conversationId: convId, messageId }));
    } else {
      api('POST', `/api/conversations/${convId}/read`, { messageId }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  function connectWs() {
    S.wsWanted = true;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    setConn('connecting');
    ws.addEventListener('open', () => {
      S.wsRetry = 0;
      setConn('online');
      if (S.hadConnection) resync();
      S.hadConnection = true;
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleWs(msg);
    });
    ws.addEventListener('close', (e) => {
      if (S.ws !== ws) return;
      S.ws = null;
      for (const [clientId, p] of S.pending) {
        S.pending.delete(clientId);
        restoreDraft(p.convId, p.text, 'Connection lost before the message was confirmed. Check and resend.');
      }
      if (!S.wsWanted || e.code === 4001) return;
      setConn('offline');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    const delay = Math.min(30_000, 1000 * 2 ** S.wsRetry++) + Math.random() * 500;
    setTimeout(async () => {
      if (!S.wsWanted) return;
      try {
        await api('GET', '/api/me'); // a 401 here routes to the login screen
        if (S.wsWanted) connectWs();
      } catch (err) {
        if (err.status === 0 && S.wsWanted) scheduleReconnect(); // still offline
      }
    }, delay);
  }

  async function resync() {
    try {
      const prev = S.convs;
      await loadConversations();
      for (const [id] of prev) if (!S.convs.has(id)) S.msgs.delete(id);
      for (const [id, st] of S.msgs) if (id !== S.activeId) st.loaded = false;
      if (S.activeId) {
        if (!S.convs.has(S.activeId)) showEmpty();
        else { await loadLatest(S.activeId); loadMembers(S.activeId); }
      }
    } catch { /* handled by api hooks */ }
  }

  function handleWs(msg) {
    switch (msg.type) {
      case 'hello':
        S.online = new Map(msg.online.map((u) => [u.id, u.username]));
        renderNav();
        renderHeader();
        break;
      case 'presence':
        if (msg.online) S.online.set(msg.user.id, msg.user.username);
        else S.online.delete(msg.user.id);
        renderNav();
        renderHeader();
        break;
      case 'message':
        onIncoming(msg.message);
        break;
      case 'ack':
        S.pending.delete(msg.clientId);
        break;
      case 'error': {
        const p = msg.clientId && S.pending.get(msg.clientId);
        if (p) {
          S.pending.delete(msg.clientId);
          restoreDraft(p.convId, p.text, msg.error);
        } else {
          toast(msg.error, 'error');
        }
        break;
      }
      case 'message_deleted':
        removeMessage(msg.conversationId, msg.messageId);
        break;
      case 'typing': {
        let map = S.typing.get(msg.conversationId);
        if (!map) S.typing.set(msg.conversationId, (map = new Map()));
        map.set(msg.user.id, { username: msg.user.username, until: Date.now() + TYPING_TTL_MS });
        if (msg.conversationId === S.activeId) {
          renderTyping();
          setTimeout(renderTyping, TYPING_TTL_MS + 50);
        }
        break;
      }
      case 'conversation_added':
        if (!S.convs.has(msg.conversation.id)) {
          S.convs.set(msg.conversation.id, msg.conversation);
          renderNav();
          if (msg.conversation.type === 'group') toast(`You were added to ${msg.conversation.name}.`);
        }
        break;
      case 'conversation_removed': {
        const conv = S.convs.get(msg.conversationId);
        S.convs.delete(msg.conversationId);
        S.msgs.delete(msg.conversationId);
        if (S.activeId === msg.conversationId) showEmpty();
        renderNav();
        if (conv) toast(`You were removed from ${conv.name}.`);
        break;
      }
      case 'members_changed':
        if (S.activeId === msg.conversationId) loadMembers(msg.conversationId);
        else S.members.delete(msg.conversationId);
        break;
      case 'session_ended':
        S.wsWanted = false;
        showAuth('login', msg.reason || 'Your session ended.');
        break;
      default:
        break;
    }
  }

  function onIncoming(message) {
    const conv = S.convs.get(message.conversationId);
    if (!conv) {
      loadConversations().catch(() => {});
      return;
    }
    conv.lastMessageAt = message.createdAt;
    const typingMap = S.typing.get(conv.id);
    if (typingMap) typingMap.delete(message.userId);

    const st = S.msgs.get(conv.id);
    if (st && st.loaded && !st.items.some((x) => x.id === message.id)) st.items.push(message);

    const mine = message.userId === S.me.id;
    const viewing = S.activeId === conv.id && document.visibilityState === 'visible' && !(isMobile() && !appView.classList.contains('show-main'));
    if (S.activeId === conv.id) {
      if (st && st.loaded) renderMessages(mine ? 'bottom' : 'auto');
      renderTyping();
      const members = S.members.get(conv.id);
      if (members && !members.some((m) => m.id === message.userId)) loadMembers(conv.id);
    }
    if (viewing) sendRead(conv.id, message.id);
    else if (!mine) conv.unread = (conv.unread || 0) + 1;
    renderNav();
  }

  // -------------------------------------------------------------------------
  // Modals: rooms, groups, DMs, details, account
  // -------------------------------------------------------------------------

  async function roomsModal() {
    const list = h('ul', { class: 'room-list' }, h('li', { class: 'muted' }, 'Loading…'));
    const nameInput = h('input', { class: 'input', placeholder: 'e.g. book-club', maxlength: '30', 'aria-label': 'New room name' });
    const err = h('p', { class: 'form-error', hidden: true });
    const quota = h('p', { class: 'field-hint' });
    const createBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create');
    const form = h('form', { class: 'form inline-form', novalidate: true },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Create a room'), h('div', { class: 'input-row' }, nameInput, createBtn), quota),
      err,
    );
    const modal = openModal('Rooms', [form, h('h3', { class: 'modal-subhead' }, 'All rooms'), list], { wide: true });

    async function refresh() {
      try {
        const { rooms, createdCount, maxCreated } = await api('GET', '/api/rooms');
        quota.textContent = `2–30 characters. You've created ${createdCount} of ${maxCreated} rooms.`;
        list.replaceChildren(...rooms.map((r) => h('li', { class: 'room-row' },
          h('span', { class: 'nav-glyph' }, icon('hash', 15)),
          h('span', { class: 'room-name' }, r.name),
          h('span', { class: 'room-meta' }, `${r.memberCount} member${r.memberCount === 1 ? '' : 's'}`),
          r.joined
            ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => { modal.close(); openConversation(r.id); } }, 'Open')
            : h('button', { type: 'button', class: 'btn btn-primary small', onclick: (e) => joinRoom(r.id, e.currentTarget) }, 'Join'),
        )));
      } catch (ex) {
        list.replaceChildren(h('li', { class: 'form-error' }, ex.message));
      }
    }

    async function joinRoom(id, btn) {
      setBusy(btn, true);
      try {
        const { conversation } = await api('POST', `/api/rooms/${id}/join`);
        S.convs.set(conversation.id, conversation);
        renderNav();
        modal.close();
        openConversation(conversation.id);
      } catch (ex) {
        toast(ex.message, 'error');
        setBusy(btn, false);
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      setBusy(createBtn, true);
      try {
        const { conversation } = await api('POST', '/api/rooms', { name: nameInput.value });
        S.convs.set(conversation.id, conversation);
        renderNav();
        modal.close();
        openConversation(conversation.id);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        setBusy(createBtn, false);
      }
    });
    refresh();
  }

  /** Username picker with live search. Returns { el, values() }. */
  function userPicker({ multiple = true, placeholder = 'Search by username', onPick } = {}) {
    const chosen = new Map();
    const chips = h('div', { class: 'chips' });
    const input = h('input', { class: 'input', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '20', 'aria-label': placeholder });
    const results = h('ul', { class: 'picker-results' });
    let timer = null;
    let seq = 0;

    function renderChips() {
      chips.replaceChildren(...[...chosen.values()].map((u) => h('span', { class: 'chip' }, avatar(u.username), u.username,
        h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${u.username}`, onclick: () => { chosen.delete(u.id); renderChips(); } }, icon('x', 12)))));
    }
    function pick(u) {
      if (onPick) return onPick(u);
      if (multiple) chosen.set(u.id, u);
      input.value = '';
      results.replaceChildren();
      renderChips();
      input.focus();
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q || !/^[A-Za-z0-9_]+$/.test(q)) { results.replaceChildren(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const { users } = await api('GET', `/api/users/search?q=${encodeURIComponent(q)}`);
          if (mine !== seq) return;
          const shown = users.filter((u) => !chosen.has(u.id));
          results.replaceChildren(...(shown.length ? shown.map((u) => h('li', null, h('button', { type: 'button', class: 'search-item', onclick: () => pick(u) },
            avatar(u.username), h('span', null, u.username), u.online ? h('span', { class: 'presence on inline' }) : null))) : [h('li', { class: 'search-empty' }, 'No matches.')]));
        } catch (ex) { toast(ex.message, 'error'); }
      }, 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = results.querySelector('.search-item');
        if (first) first.click();
      }
    });
    return { el: h('div', { class: 'picker' }, chips, input, results), values: () => [...chosen.values()].map((u) => u.username), input };
  }

  function newGroupModal() {
    const name = h('input', { class: 'input', maxlength: '30', placeholder: 'e.g. Weekend plans' });
    const picker = userPicker();
    const err = h('p', { class: 'form-error', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create group');
    const form = h('form', { class: 'form', novalidate: true },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Group name'), name),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Invite people'), picker.el),
      h('p', { class: 'field-hint' }, 'Only members can read or post. You can add or remove people later.'),
      err,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit),
    );
    const modal = openModal('New private group', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      setBusy(submit, true);
      try {
        const { conversation, notAdded } = await api('POST', '/api/groups', { name: name.value, members: picker.values() });
        S.convs.set(conversation.id, conversation);
        renderNav();
        modal.close();
        openConversation(conversation.id);
        if (notAdded.length) toast(`Couldn't add: ${notAdded.map((n) => n.username).join(', ')}`, 'error');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        setBusy(submit, false);
      }
    });
  }

  function newDmModal() {
    const picker = userPicker({
      multiple: false,
      placeholder: 'Who do you want to message?',
      onPick: (u) => { modal.close(); startDm(u.username); },
    });
    const modal = openModal('New direct message', [picker.el, h('p', { class: 'field-hint' }, 'Start typing a username.')]);
    picker.input.focus();
  }

  async function detailsModal() {
    const conv = S.convs.get(S.activeId);
    if (!conv) return;
    const listEl = h('ul', { class: 'member-list' }, h('li', { class: 'muted' }, 'Loading…'));
    const content = [];
    const isCreator = conv.type === 'group' && conv.createdBy === S.me.id;

    if (conv.type === 'group' && isCreator) {
      const err = h('p', { class: 'form-error', hidden: true });
      const picker = userPicker({
        multiple: false,
        placeholder: 'Add someone by username',
        onPick: async (u) => {
          err.hidden = true;
          try {
            await api('POST', `/api/groups/${conv.id}/members`, { username: u.username });
            picker.input.value = '';
            picker.el.querySelector('.picker-results').replaceChildren();
            toast(`${u.username} was added.`, 'success');
            refresh();
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
          }
        },
      });
      content.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Add members'), picker.el, err));
    }

    content.push(h('h3', { class: 'modal-subhead' }, conv.type === 'dm' ? 'People' : 'Members'), listEl);

    const actions = h('div', { class: 'modal-actions spread' });
    if (conv.type === 'group') {
      actions.append(h('button', { type: 'button', class: 'btn btn-danger-ghost', onclick: leaveGroup }, 'Leave group'));
    } else if (conv.type === 'room') {
      actions.append(h('button', { type: 'button', class: 'btn btn-danger-ghost', onclick: leaveRoom }, 'Leave room'));
    } else if (conv.otherUser) {
      actions.append(h('button', { type: 'button', class: 'btn btn-danger-ghost', onclick: () => { modal.close(); blockUser(conv.otherUser.id, conv.otherUser.username); } }, `Block ${conv.otherUser.username}`));
    }
    content.push(actions);

    const title = conv.type === 'room' ? `#${conv.name}` : conv.name;
    const modal = openModal(title, content, { wide: true });

    async function refresh() {
      await loadMembers(conv.id);
      const members = S.members.get(conv.id) || [];
      const ordered = [...members].sort((a, b) => (S.online.has(b.id) - S.online.has(a.id)) || a.username.localeCompare(b.username));
      listEl.replaceChildren(...ordered.map((m) => h('li', { class: 'member-row' },
        h('span', { class: 'nav-avatar' }, avatar(m.username), h('span', { class: `presence${S.online.has(m.id) ? ' on' : ''}` })),
        h('span', { class: 'member-name' }, m.username, m.id === S.me.id ? h('span', { class: 'tag' }, 'you') : null,
          conv.type !== 'dm' && m.id === conv.createdBy ? h('span', { class: 'tag' }, conv.type === 'group' ? 'owner' : 'creator') : null),
        isCreator && m.id !== S.me.id
          ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => removeMember(m) }, 'Remove')
          : m.id !== S.me.id && conv.type !== 'dm'
            ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => { modal.close(); startDm(m.username); } }, 'Message')
            : null,
      )));
    }

    async function removeMember(m) {
      const ok = await confirmDialog(`Remove ${m.username}?`, `${m.username} will lose access to ${conv.name}.`, { confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      try {
        await api('DELETE', `/api/groups/${conv.id}/members/${m.id}`);
        refresh();
      } catch (ex) { toast(ex.message, 'error'); }
    }

    async function leaveGroup() {
      const ok = await confirmDialog(`Leave ${conv.name}?`, "You'll lose access to this group's messages unless someone adds you back.", { confirmLabel: 'Leave', danger: true });
      if (!ok) return;
      try {
        await api('POST', `/api/groups/${conv.id}/leave`);
        modal.close();
        S.convs.delete(conv.id);
        S.msgs.delete(conv.id);
        showEmpty();
      } catch (ex) { toast(ex.message, 'error'); }
    }

    async function leaveRoom() {
      try {
        await api('POST', `/api/rooms/${conv.id}/leave`);
        modal.close();
        S.convs.delete(conv.id);
        S.msgs.delete(conv.id);
        showEmpty();
        toast(`You left #${conv.name}. You can rejoin from Rooms.`);
      } catch (ex) { toast(ex.message, 'error'); }
    }

    refresh();
  }

  function accountModal() {
    const item = (iconName, label, onclick, cls = '') => h('button', { type: 'button', class: `menu-item ${cls}`, onclick }, icon(iconName, 17), h('span', null, label));
    const modal = openModal('Account', h('div', { class: 'menu' },
      h('div', { class: 'menu-me' }, avatar(S.me.username, 'large'), h('div', null, h('strong', null, S.me.username), h('span', { class: 'muted' }, S.me.isAdmin ? 'Admin' : 'Member'))),
      item('lock', 'Change password', () => { modal.close(); passwordModal(); }),
      item('slash', 'Blocked users', () => { modal.close(); blockedModal(); }),
      S.me.isAdmin ? item('shield', 'Admin dashboard', () => { location.href = '/admin'; }) : null,
      h('hr'),
      item('logout', 'Log out', () => { modal.close(); logout(); }),
      item('logout', 'Log out everywhere', async () => {
        modal.close();
        const ok = await confirmDialog('Log out everywhere?', 'This signs you out on every device, including this one.', { confirmLabel: 'Log out everywhere', danger: true });
        if (!ok) return;
        try { await api('POST', '/api/logout-all'); } catch { /* ignore */ }
        showAuth('login', 'You were logged out on all devices.');
      }, 'danger'),
    ));
  }

  function passwordModal() {
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: '72' });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '72' });
    const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '72' });
    const err = h('p', { class: 'form-error', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password');
    const form = h('form', { class: 'form', novalidate: true },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Current password'), current),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'New password'), next, h('span', { class: 'field-hint' }, '8–72 characters.')),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirm new password'), confirm),
      err,
      h('p', { class: 'field-hint' }, 'Your other devices will be signed out.'),
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit),
    );
    const modal = openModal('Change password', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (next.value !== confirm.value) { err.textContent = "Passwords don't match."; err.hidden = false; return; }
      setBusy(submit, true);
      try {
        await api('POST', '/api/password', { currentPassword: current.value, newPassword: next.value });
        modal.close();
        toast('Password changed. Your other devices were signed out.', 'success');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        setBusy(submit, false);
      }
    });
  }

  async function blockedModal() {
    const list = h('ul', { class: 'member-list' }, h('li', { class: 'muted' }, 'Loading…'));
    openModal('Blocked users', [h('p', { class: 'field-hint' }, "Blocked people can't start DMs with you, and you won't see their messages. They aren't told."), list]);
    async function refresh() {
      try {
        const { users } = await api('GET', '/api/blocks');
        list.replaceChildren(...(users.length ? users.map((u) => h('li', { class: 'member-row' },
          avatar(u.username), h('span', { class: 'member-name' }, u.username),
          h('button', {
            type: 'button', class: 'btn btn-ghost small',
            onclick: async () => {
              try {
                await api('DELETE', `/api/blocks/${u.id}`);
                for (const st of S.msgs.values()) st.loaded = false;
                if (S.activeId) loadLatest(S.activeId);
                refresh();
              } catch (ex) { toast(ex.message, 'error'); }
            },
          }, 'Unblock'))) : [h('li', { class: 'muted' }, "You haven't blocked anyone.")]));
      } catch (ex) {
        list.replaceChildren(h('li', { class: 'form-error' }, ex.message));
      }
    }
    refresh();
  }

  // -------------------------------------------------------------------------
  // Wiring and boot
  // -------------------------------------------------------------------------

  function wireApp() {
    $('#btn-rooms').replaceChildren(icon('plus', 16));
    $('#btn-group').replaceChildren(icon('plus', 16));
    $('#btn-dm').replaceChildren(icon('plus', 16));
    $('#btn-rooms').addEventListener('click', roomsModal);
    $('#btn-group').addEventListener('click', newGroupModal);
    $('#btn-dm').addEventListener('click', newDmModal);
    $('#btn-me').addEventListener('click', accountModal);
    $('#btn-details').addEventListener('click', detailsModal);
    $('#btn-back').addEventListener('click', () => {
      appView.classList.remove('show-main');
      if (S.activeId) S.drafts.set(S.activeId, $('#composer-input').value);
    });

    const box = $('#messages');
    box.addEventListener('scroll', () => { if (box.scrollTop < 120) loadOlder(); }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !S.activeId) return;
      const conv = S.convs.get(S.activeId);
      const st = S.msgs.get(S.activeId);
      if (conv && conv.unread && st && st.items.length) {
        sendRead(conv.id, st.items[st.items.length - 1].id);
        conv.unread = 0;
        renderNav();
      }
    });

    wireComposer();
    wireSearch();
  }

  async function boot() {
    wireAuth();
    wireApp();
    try { S.config = await api('GET', '/api/config'); } catch { /* defaults */ }
    try {
      const { user } = await api('GET', '/api/me');
      S.me = user;
      if (user.mustChangePassword) showAuth('reset');
      else await startApp();
    } catch {
      showAuth('login');
    }
    $('#boot').remove();
  }

  boot();
})();
