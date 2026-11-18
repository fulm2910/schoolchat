'use strict';

/*
 * End-to-end tests. Starts the real server on a free port with a throwaway
 * SQLite file, then drives it over HTTP and WebSockets like a browser would.
 *
 * Run with: npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolchat-test-'));
const secrets = new Set(); // passwords and tokens that must never appear in logs
const servers = [];

let BASE;
let DB_PATH;
let ipCounter = 1;
const nextIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dbPath = path.join(tmpDir, `chat-${port}.db`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      TRUST_PROXY: '1',
      INVITE_CODE: '',
      SESSION_DAYS: '30',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { child, port, dbPath, output: '', base: `http://127.0.0.1:${port}` };
  child.stdout.on('data', (d) => { server.output += d; });
  child.stderr.on('data', (d) => { server.output += d; });
  servers.push(server);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${server.output}`)), 15_000);
    const check = () => {
      if (server.output.includes('listening')) { clearTimeout(timer); resolve(); } else if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`server exited:\n${server.output}`));
      } else setTimeout(check, 50);
    };
    check();
  });
  return server;
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  const exited = new Promise((r) => server.child.once('exit', r));
  server.child.kill('SIGTERM');
  await exited;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function solve(question) {
  const m = /What is (\d+) ([+\-×]) (\d+)\?/.exec(question);
  assert.ok(m, `unexpected challenge: ${question}`);
  const a = Number(m[1]);
  const b = Number(m[3]);
  return String(m[2] === '+' ? a + b : m[2] === '-' ? a - b : a * b);
}

class Client {
  constructor(base = BASE) {
    this.base = base;
    this.ip = nextIp();
    this.cookie = '';
    this.user = null;
  }

  async req(method, url, body, headers = {}) {
    const h = { 'X-Forwarded-For': this.ip, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(this.base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const m = /^sid=([^;]*)/.exec(c);
      if (m) {
        this.cookie = m[1] ? `sid=${m[1]}` : '';
        if (m[1]) secrets.add(m[1]);
      }
    }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, setCookies };
  }

  get(url) { return this.req('GET', url); }
  post(url, body = {}) { return this.req('POST', url, body); }
  del(url) { return this.req('DELETE', url); }

  async signup(username, password, extra = {}) {
    secrets.add(password);
    const ch = await this.get('/api/challenge');
    assert.equal(ch.status, 200);
    const res = await this.post('/api/signup', { username, password, challengeId: ch.data.id, answer: solve(ch.data.question), ...extra });
    if (res.status === 201) this.user = res.data.user;
    return res;
  }

  async login(username, password) {
    const res = await this.post('/api/login', { username, password });
    if (res.status === 200) this.user = res.data.user;
    return res;
  }

  async conversations() {
    const res = await this.get('/api/conversations');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.conversations;
  }

  async roomId(name) {
    const conv = (await this.conversations()).find((c) => c.type === 'room' && c.name === name);
    assert.ok(conv, `room ${name} not found`);
    return conv.id;
  }

  async messages(conversationId) {
    return this.get(`/api/conversations/${conversationId}/messages`);
  }

  send(conversationId, body) {
    return this.post(`/api/conversations/${conversationId}/messages`, { body });
  }

  socket(opts) { return openSocket(this, opts); }
}

/** Opens a WebSocket with the client's cookie. Resolves after the server's hello. */
function openSocket(client, { origin = client.base, cookie = client.cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = client.base.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(url, { ...(origin ? { origin } : {}), headers: cookie ? { Cookie: cookie } : {} });
    const inbox = [];
    const waiters = [];
    const closed = new Promise((r) => ws.once('close', (code) => r(code)));
    const wrapper = {
      ws,
      inbox,
      closed,
      send(obj) { ws.send(JSON.stringify(obj)); },
      clear() { inbox.length = 0; },
      /** Resolves with (and removes) the first message matching pred. */
      waitFor(pred, ms = 3000) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timed out waiting for socket message')); }, ms) };
          waiters.push(w);
        });
      },
      /** Waits a bit and asserts nothing matching pred arrived. */
      async expectNone(pred, ms = 400) {
        await new Promise((r) => setTimeout(r, ms));
        assert.equal(inbox.filter(pred).length, 0, 'received a socket message that should have been hidden');
      },
      close() { ws.close(); return closed; },
    };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const w = waiters.find((x) => x.pred(msg));
      if (w) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.res(msg);
      } else inbox.push(msg);
      if (msg.type === 'hello') resolve(wrapper);
    });
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })));
    ws.once('error', reject);
  });
}

const isMessage = (convId, body) => (m) => m.type === 'message' && m.message.conversationId === convId && (body === undefined || m.message.body === body);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PW = {
  admin: 'admin-pass-1234',
  alice: 'alice-pass-1234',
  bob: 'bob-pass-12345',
  carol: 'carol-pass-1234',
  dave: 'dave-pass-12345',
  erin: 'erin-pass-12345',
  frank: 'frank-pass-1234',
};

const admin = new Client();
const alice = new Client();
const bob = new Client();
const carol = new Client();
const dave = new Client();
const erin = new Client();
const frank = new Client();
const sockets = [];

let generalId;
let dmId;
let groupId;

before(async () => {
  const server = await startServer();
  BASE = server.base;
  DB_PATH = server.dbPath;
  for (const c of [admin, alice, bob, carol, dave, erin, frank]) c.base = BASE;
});

after(async () => {
  for (const s of sockets) s.ws.terminate();
  for (const s of servers) await stopServer(s);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const track = (s) => { sockets.push(s); return s; };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('serves the app with a strict CSP and security headers', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
  const html = await res.text();
  assert.match(html, /<title>schoolchat<\/title>/);
});

test('frontend never uses innerHTML or other HTML sinks', () => {
  for (const file of ['app.js', 'admin.js', 'common.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, file);
  }
});

test('signup validates input, the math challenge and the honeypot', async () => {
  const c = new Client();
  const ch = await c.get('/api/challenge');
  assert.match(ch.data.question, /What is \d+ [+\-×] \d+\?/);

  let res = await c.signup('ab', 'long-enough-pw');
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'INVALID_USERNAME');

  res = await c.signup('bad name!', 'long-enough-pw');
  assert.equal(res.status, 400);

  res = await c.signup('validname', 'short');
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'INVALID_PASSWORD');

  res = await c.signup('validname', 'x'.repeat(73));
  assert.equal(res.status, 400);

  const c2 = new Client();
  const ch2 = await c2.get('/api/challenge');
  const wrong = String(Number(solve(ch2.data.question)) + 1);
  res = await c2.post('/api/signup', { username: 'validname', password: 'long-enough-pw', challengeId: ch2.data.id, answer: wrong });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'BAD_CHALLENGE');
  // A challenge is single use, even the right answer fails after an attempt.
  res = await c2.post('/api/signup', { username: 'validname', password: 'long-enough-pw', challengeId: ch2.data.id, answer: solve(ch2.data.question) });
  assert.equal(res.data.code, 'BAD_CHALLENGE');

  const c3 = new Client();
  res = await c3.signup('validname', 'long-enough-pw', { website: 'http://spam.example' });
  assert.equal(res.status, 400);
});

test('first account becomes admin; usernames are unique ignoring case', async () => {
  let res = await admin.signup('admin', PW.admin);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.user.isAdmin, true);
  const cookie = res.setCookies.find((c) => c.startsWith('sid='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/); // plain HTTP in tests

  res = await alice.signup('alice', PW.alice);
  assert.equal(res.status, 201);
  assert.equal(res.data.user.isAdmin, false);

  res = await new Client().signup('ALICE', 'another-password');
  assert.equal(res.status, 409);

  for (const [name, c] of [['bob', bob], ['carol', carol], ['dave', dave], ['erin', erin], ['frank', frank]]) {
    res = await c.signup(name, PW[name]);
    assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.data)}`);
  }

  // New users are placed in the seeded rooms.
  const names = (await alice.conversations()).map((c) => c.name).sort();
  assert.deepEqual(names, ['general', 'random']);
  generalId = await alice.roomId('general');
});

test('sessions store only a SHA-256 hash with an expiry', () => {
  const token = alice.cookie.replace(/^sid=/, '');
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
    assert.ok(row, 'hashed token stored');
    assert.ok(row.expires_at > Date.now() + 29 * 86_400_000);
    const raw = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n;
    assert.equal(raw, 0, 'raw token must not be stored');
    const user = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('alice');
    assert.match(user.password_hash, /^\$2[aby]\$12\$/, 'bcrypt cost 12');
  } finally {
    db.close();
  }
});

test('login returns identical errors for a wrong username and a wrong password', async () => {
  const c = new Client();
  const wrongUser = await c.login('nobody_here', PW.alice);
  const wrongPass = await c.login('alice', 'not-the-password');
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongPass.status, 401);
  assert.deepEqual(wrongUser.data, wrongPass.data);

  const ok = await c.login('ALICE', PW.alice); // case-insensitive username
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.username, 'alice');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, 'alice');

  assert.equal((await new Client().get('/api/me')).status, 401);
});

test('logout ends one session; log out everywhere ends all of them', async () => {
  const second = new Client();
  await second.login('alice', PW.alice);
  const third = new Client();
  await third.login('alice', PW.alice);

  const savedCookie = second.cookie;
  assert.equal((await second.post('/api/logout')).status, 200);
  second.cookie = savedCookie; // replaying the old cookie must not work
  assert.equal((await second.get('/api/me')).status, 401);
  assert.equal((await third.get('/api/me')).status, 200);
  assert.equal((await alice.get('/api/me')).status, 200);

  const thirdSocket = await third.socket();
  assert.equal((await third.post('/api/logout-all')).status, 200);
  assert.equal(await thirdSocket.closed, 4001);
  assert.equal((await alice.get('/api/me')).status, 401);

  assert.equal((await alice.login('alice', PW.alice)).status, 200);
});

test('websocket rejects foreign origins and missing sessions; API rejects cross-origin writes', async () => {
  await assert.rejects(alice.socket({ origin: 'http://evil.example' }), (e) => e.statusCode === 403);
  await assert.rejects(alice.socket({ origin: null }), (e) => e.statusCode === 403);
  await assert.rejects(new Client().socket(), (e) => e.statusCode === 401);
  await assert.rejects(alice.socket({ cookie: 'sid=forged-token' }), (e) => e.statusCode === 401);

  const res = await alice.req('POST', `/api/conversations/${generalId}/messages`, { body: 'csrf' }, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
});

test('room messages are delivered live, stored, and validated', async () => {
  const a = track(await alice.socket());
  const b = track(await bob.socket());

  a.send({ type: 'send', clientId: 'c1', conversationId: generalId, body: '  Hello, general!  ' });
  const ack = await a.waitFor((m) => m.type === 'ack' && m.clientId === 'c1');
  assert.ok(ack.messageId);
  const live = await b.waitFor(isMessage(generalId, 'Hello, general!'));
  assert.equal(live.message.username, 'alice');

  const history = await bob.messages(generalId);
  assert.equal(history.status, 200);
  assert.ok(history.data.messages.some((m) => m.id === ack.messageId && m.body === 'Hello, general!'));

  // Empty and oversized messages are rejected, over both transports.
  a.send({ type: 'send', clientId: 'c2', conversationId: generalId, body: '   \n  ' });
  const empty = await a.waitFor((m) => m.type === 'error' && m.clientId === 'c2');
  assert.equal(empty.code, 'EMPTY');
  assert.equal((await alice.send(generalId, '')).status, 400);
  const long = await alice.send(generalId, 'x'.repeat(2001));
  assert.equal(long.status, 400);
  assert.equal(long.data.code, 'TOO_LONG');
  assert.equal((await alice.send(generalId, 'y'.repeat(2000))).status, 201);

  // Typing indicators reach other members.
  a.send({ type: 'typing', conversationId: generalId });
  const typing = await b.waitFor((m) => m.type === 'typing' && m.conversationId === generalId);
  assert.equal(typing.user.username, 'alice');

  // Unread counts: carol has not opened general yet.
  const carolGeneral = (await carol.conversations()).find((c) => c.id === generalId);
  assert.ok(carolGeneral.unread >= 2);
  await carol.messages(generalId); // opening marks it read
  assert.equal((await carol.conversations()).find((c) => c.id === generalId).unread, 0);
});

test('history pages back with "before"', async () => {
  const room = await carol.post('/api/rooms', { name: 'history-test' });
  assert.equal(room.status, 201);
  const id = room.data.conversation.id;
  // Insert 105 messages directly so the message rate limit does not slow the test down.
  const db = new Database(DB_PATH, { fileMustExist: true });
  const carolId = carol.user.id;
  const insert = db.prepare('INSERT INTO messages (conversation_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
  db.transaction(() => { for (let i = 1; i <= 105; i++) insert.run(id, carolId, `msg ${i}`, Date.now()); })();
  db.close();

  const first = await carol.messages(id);
  assert.equal(first.data.messages.length, 100);
  assert.equal(first.data.hasMore, true);
  assert.equal(first.data.messages[0].body, 'msg 6');
  assert.equal(first.data.messages.at(-1).body, 'msg 105');
  const older = await carol.get(`/api/conversations/${id}/messages?before=${first.data.messages[0].id}`);
  assert.equal(older.data.messages.length, 5);
  assert.equal(older.data.hasMore, false);
  assert.equal(older.data.messages[0].body, 'msg 1');
});

test('room membership is enforced and room creation is limited', async () => {
  const res = await alice.post('/api/rooms', { name: 'book-club' });
  assert.equal(res.status, 201);
  const roomId = res.data.conversation.id;

  assert.equal((await bob.messages(roomId)).status, 403);
  assert.equal((await bob.send(roomId, 'let me in')).status, 403);

  assert.equal((await bob.post(`/api/rooms/${roomId}/join`)).status, 200);
  assert.equal((await bob.messages(roomId)).status, 200);
  assert.equal((await bob.send(roomId, 'joined!')).status, 201);
  assert.equal((await bob.post(`/api/rooms/${roomId}/leave`)).status, 200);
  assert.equal((await bob.messages(roomId)).status, 403);

  assert.equal((await alice.post('/api/rooms', { name: 'x' })).status, 400);
  assert.equal((await alice.post('/api/rooms', { name: 'y'.repeat(31) })).status, 400);
  assert.equal((await alice.post('/api/rooms', { name: 'BOOK-CLUB' })).status, 409);
  for (let i = 2; i <= 5; i++) assert.equal((await alice.post('/api/rooms', { name: `room ${i}` })).status, 201);
  const sixth = await alice.post('/api/rooms', { name: 'room 6' });
  assert.equal(sixth.status, 400);
  assert.match(sixth.data.error, /up to 5/);
});

test('direct messages are private to the two people', async () => {
  const b = sockets[1];
  const res = await alice.post('/api/dms', { username: 'bob' });
  assert.equal(res.status, 201);
  dmId = res.data.conversation.id;
  assert.equal(res.data.conversation.name, 'bob');
  const added = await b.waitFor((m) => m.type === 'conversation_added' && m.conversation.id === dmId);
  assert.equal(added.conversation.name, 'alice');

  // Opening the same DM again returns the existing conversation.
  const again = await bob.post('/api/dms', { username: 'alice' });
  assert.equal(again.status, 200);
  assert.equal(again.data.conversation.id, dmId);

  assert.equal((await alice.send(dmId, 'hi bob, just us')).status, 201);
  await b.waitFor(isMessage(dmId, 'hi bob, just us'));

  assert.equal((await carol.messages(dmId)).status, 403);
  assert.equal((await carol.send(dmId, 'sneaky')).status, 403);
  const c = track(await carol.socket());
  c.send({ type: 'send', clientId: 'x', conversationId: dmId, body: 'sneaky ws' });
  const err = await c.waitFor((m) => m.type === 'error' && m.clientId === 'x');
  assert.equal(err.code, 'FORBIDDEN');

  assert.equal((await alice.post('/api/dms', { username: 'alice' })).status, 400);
  assert.equal((await alice.post('/api/dms', { username: 'ghost_user' })).status, 404);

  const search = await alice.get('/api/users/search?q=bo');
  assert.ok(search.data.users.some((u) => u.username === 'bob'));
  assert.ok(!search.data.users.some((u) => u.username === 'alice'));
});

test('private groups: only members read or post; creator manages; members can leave', async () => {
  const c = sockets[2];
  const res = await alice.post('/api/groups', { name: 'Secret plans', members: ['bob', 'nobody_xyz'] });
  assert.equal(res.status, 201);
  groupId = res.data.conversation.id;
  assert.deepEqual(res.data.notAdded.map((n) => n.username), ['nobody_xyz']);

  assert.equal((await bob.send(groupId, 'in the group')).status, 201);
  assert.equal((await carol.messages(groupId)).status, 403);
  assert.equal((await carol.send(groupId, 'not a member')).status, 403);
  assert.equal((await carol.get(`/api/conversations/${groupId}/members`)).status, 403);

  // Only the creator can add or remove.
  assert.equal((await bob.post(`/api/groups/${groupId}/members`, { username: 'carol' })).status, 403);
  assert.equal((await alice.post(`/api/groups/${groupId}/members`, { username: 'carol' })).status, 201);
  await c.waitFor((m) => m.type === 'conversation_added' && m.conversation.id === groupId);
  assert.equal((await carol.messages(groupId)).status, 200);
  assert.equal((await carol.send(groupId, 'thanks for adding me')).status, 201);

  assert.equal((await bob.del(`/api/groups/${groupId}/members/${carol.user.id}`)).status, 403);
  assert.equal((await alice.del(`/api/groups/${groupId}/members/${carol.user.id}`)).status, 200);
  await c.waitFor((m) => m.type === 'conversation_removed' && m.conversationId === groupId);
  assert.equal((await carol.messages(groupId)).status, 403);
  assert.equal((await carol.send(groupId, 'still here?')).status, 403);

  assert.equal((await bob.post(`/api/groups/${groupId}/leave`)).status, 200);
  assert.equal((await bob.messages(groupId)).status, 403);
  assert.equal((await bob.send(groupId, 'after leaving')).status, 403);
});

test('blocking hides messages for the blocker and stops new DMs', async () => {
  const [a, b, c] = sockets;
  assert.equal((await bob.post('/api/blocks', { username: 'alice' })).status, 201);
  b.clear();
  c.clear();

  assert.equal((await alice.send(generalId, 'can bob see this?')).status, 201);
  await c.waitFor(isMessage(generalId, 'can bob see this?'));
  await b.expectNone(isMessage(generalId, 'can bob see this?'));

  // Typing from a blocked user is hidden too (wait out the 1.5 s typing throttle first).
  await new Promise((r) => setTimeout(r, 1600));
  a.send({ type: 'typing', conversationId: generalId });
  await c.waitFor((m) => m.type === 'typing' && m.user.username === 'alice');
  await b.expectNone((m) => m.type === 'typing' && m.user.username === 'alice');

  const bobView = await bob.messages(generalId);
  assert.ok(!bobView.data.messages.some((m) => m.userId === alice.user.id), 'blocked user hidden from history');
  const carolView = await carol.messages(generalId);
  assert.ok(carolView.data.messages.some((m) => m.body === 'can bob see this?'));

  // A blocked user cannot start a new DM with the blocker.
  assert.equal((await bob.post('/api/blocks', { username: 'dave' })).status, 201);
  const dm = await dave.post('/api/dms', { username: 'bob' });
  assert.equal(dm.status, 403);
  assert.doesNotMatch(dm.data.error, /block/i, 'the error does not reveal the block');
  // ...and cannot add the blocker to a group.
  const grp = await dave.post('/api/groups', { name: 'Dave crew', members: ['bob'] });
  assert.equal(grp.data.notAdded.length, 1);

  const list = await bob.get('/api/blocks');
  assert.deepEqual(list.data.users.map((u) => u.username).sort(), ['alice', 'dave']);
  assert.deepEqual((await alice.get('/api/blocks')).data.users, []);

  assert.equal((await bob.del(`/api/blocks/${alice.user.id}`)).status, 200);
  const afterUnblock = await bob.messages(generalId);
  assert.ok(afterUnblock.data.messages.some((m) => m.body === 'can bob see this?'));
});

test('word filter rejects listed words including common substitutions', async () => {
  // A fresh user, so the earlier tests' messages don't count toward the send rate limit.
  const gina = new Client();
  assert.equal((await gina.signup('gina', 'gina-pass-12345')).status, 201);
  assert.equal((await alice.post('/api/admin/filter', { word: 'badword' })).status, 403);
  assert.equal((await alice.get('/api/admin/filter')).status, 403);
  const added = await admin.post('/api/admin/filter', { word: 'BadWord' });
  assert.equal(added.status, 201);
  assert.equal((await admin.post('/api/admin/filter', { word: 'badword' })).status, 409);

  for (const text of ['this has a badword in it', 'BADWORD!', 'b4dw0rd', 'B@DW0RD here', 'b a d w o r d', 'bádwörd']) {
    const res = await gina.send(generalId, text);
    assert.equal(res.status, 400, `should reject: ${text}`);
    assert.equal(res.data.code, 'FILTERED');
    assert.match(res.data.error, /not allowed/);
  }
  assert.equal((await gina.send(generalId, 'badwords are a different word')).status, 201);

  // Rooms and usernames go through the filter too.
  assert.equal((await carol.post('/api/rooms', { name: 'badword zone' })).status, 400);
  assert.equal((await new Client().signup('badword_fan', 'long-enough-pw')).status, 400);

  const words = await admin.get('/api/admin/filter');
  const entry = words.data.words.find((w) => w.word === 'badword');
  assert.equal((await admin.del(`/api/admin/filter/${entry.id}`)).status, 200);
  assert.equal((await gina.send(generalId, 'badword is fine now')).status, 201);
});

test('reports reach admins with context; admins delete any message', async () => {
  const c = sockets[2];
  const target = await alice.send(generalId, 'a message worth reporting');
  const messageId = target.data.message.id;

  assert.equal((await carol.post(`/api/messages/${messageId}/report`, { reason: 'Rude' })).status, 201);
  assert.equal((await carol.post(`/api/messages/${messageId}/report`, { reason: 'again' })).status, 409);
  assert.equal((await alice.post(`/api/messages/${messageId}/report`)).status, 400);

  assert.equal((await carol.get('/api/admin/reports')).status, 403);
  const reports = await admin.get('/api/admin/reports');
  assert.equal(reports.status, 200);
  const report = reports.data.reports.find((r) => r.messageId === messageId);
  assert.ok(report);
  assert.equal(report.reason, 'Rude');
  assert.equal(report.reporterName, 'carol');
  assert.equal(report.authorName, 'alice');
  assert.ok(report.context.length > 1, 'includes surrounding messages');
  assert.ok(report.context.find((m) => m.reported).body === 'a message worth reporting');

  // Users delete only their own messages.
  assert.equal((await bob.del(`/api/messages/${messageId}`)).status, 403);
  const own = await bob.send(generalId, 'my own message');
  assert.equal((await bob.del(`/api/messages/${own.data.message.id}`)).status, 200);

  c.clear();
  assert.equal((await admin.del(`/api/messages/${messageId}`)).status, 200);
  const del = await c.waitFor((m) => m.type === 'message_deleted' && m.messageId === messageId);
  assert.equal(del.conversationId, generalId);
  const history = await carol.messages(generalId);
  assert.ok(!history.data.messages.some((m) => m.id === messageId));
  const open = await admin.get('/api/admin/reports?status=open');
  assert.ok(!open.data.reports.some((r) => r.messageId === messageId), 'report resolved by deletion');
});

test('bans end sessions immediately and block login', async () => {
  const d = await dave.socket();
  assert.equal((await alice.post(`/api/admin/users/${dave.user.id}/ban`)).status, 403);
  assert.equal((await admin.post(`/api/admin/users/${admin.user.id}/ban`)).status, 400);
  assert.equal((await admin.post(`/api/admin/users/${dave.user.id}/ban`)).status, 200);

  assert.equal(await d.closed, 4001);
  assert.equal((await dave.get('/api/me')).status, 401);
  const login = await dave.login('dave', PW.dave);
  assert.equal(login.status, 403);
  assert.equal(login.data.code, 'BANNED');
  // Wrong password for a banned account still gets the generic error.
  const wrong = await dave.login('dave', 'wrong-password');
  assert.equal(wrong.status, 401);

  const users = await admin.get('/api/admin/users?q=dave');
  assert.equal(users.data.users[0].isBanned, true);
  assert.ok(!(await alice.get('/api/users/search?q=dave')).data.users.length, 'banned users hidden from search');

  assert.equal((await admin.post(`/api/admin/users/${dave.user.id}/unban`)).status, 200);
  assert.equal((await dave.login('dave', PW.dave)).status, 200);
});

test('admin password reset forces a change at next login', async () => {
  const e = await erin.socket();
  const temp = 'Temporary-Pass-42';
  secrets.add(temp);
  assert.equal((await admin.post(`/api/admin/users/${erin.user.id}/reset-password`, { password: 'short' })).status, 400);
  assert.equal((await admin.post(`/api/admin/users/${erin.user.id}/reset-password`, { password: temp })).status, 200);

  assert.equal(await e.closed, 4001);
  assert.equal((await erin.get('/api/me')).status, 401);
  assert.equal((await erin.login('erin', PW.erin)).status, 401);

  const login = await erin.login('erin', temp);
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);

  const blocked = await erin.get('/api/conversations');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await erin.send(generalId, 'can I post?')).status, 403);
  await assert.rejects(erin.socket(), (err) => err.statusCode === 403);

  const newPw = 'erins-new-password';
  secrets.add(newPw);
  assert.equal((await erin.post('/api/password', { currentPassword: 'wrong', newPassword: newPw })).status, 400);
  assert.equal((await erin.post('/api/password', { currentPassword: temp, newPassword: temp })).status, 400);
  const changed = await erin.post('/api/password', { currentPassword: temp, newPassword: newPw });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.mustChangePassword, false);
  assert.equal((await erin.get('/api/conversations')).status, 200);
  assert.equal((await new Client().login('erin', newPw)).status, 200);

  // Promotion.
  assert.equal((await erin.get('/api/admin/users')).status, 403);
  assert.equal((await admin.post(`/api/admin/users/${erin.user.id}/promote`)).status, 200);
  assert.equal((await erin.get('/api/admin/users')).status, 200);
});

test('changing your own password needs the current one and signs out other devices', async () => {
  const other = new Client();
  await other.login('carol', PW.carol);
  assert.equal((await carol.post('/api/password', { currentPassword: 'nope', newPassword: 'carol-new-pass' })).status, 400);
  const newPw = 'carol-new-pass-1';
  secrets.add(newPw);
  assert.equal((await carol.post('/api/password', { currentPassword: PW.carol, newPassword: newPw })).status, 200);
  assert.equal((await carol.get('/api/me')).status, 200, 'current session kept');
  assert.equal((await other.get('/api/me')).status, 401, 'other sessions ended');
  PW.carol = newPw;
});

test('message sending is rate limited and identical repeats are throttled', async () => {
  const id = await frank.roomId('random');
  assert.equal((await frank.send(id, 'same thing')).status, 201);
  const dup = await frank.send(id, 'Same   thing');
  assert.equal(dup.status, 429);
  assert.equal(dup.data.code, 'DUPLICATE');
  // Two attempts used; eight more fill the 10-per-10s window.
  for (let i = 1; i <= 8; i++) assert.equal((await frank.send(id, `message ${i}`)).status, 201, `message ${i}`);
  const limited = await frank.send(id, 'one too many');
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'RATE_LIMITED');
});

test('login attempts are rate limited per IP', async () => {
  const c = new Client();
  for (let i = 0; i < 10; i++) assert.equal((await c.login('frank', `wrong-${i}-password`)).status, 401);
  const limited = await c.login('frank', PW.frank);
  assert.equal(limited.status, 429, 'even the right password is refused while limited');
  // A different IP is unaffected.
  assert.equal((await new Client().login('frank', PW.frank)).status, 200);
});

test('signups are rate limited per IP', async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) {
    const res = await c.post('/api/signup', { username: `spam_${i}`, password: 'long-enough-pw', challengeId: 'bogus', answer: '1' });
    assert.equal(res.status, 400);
  }
  const res = await c.post('/api/signup', { username: 'spam_6', password: 'long-enough-pw', challengeId: 'bogus', answer: '1' });
  assert.equal(res.status, 429);
});

test('INVITE_CODE, when set, is required for signup', async () => {
  const server = await startServer({ INVITE_CODE: 'let-me-in' });
  const c = new Client(server.base);
  assert.equal((await c.get('/api/config')).data.inviteRequired, true);
  let res = await c.signup('invitee', 'long-enough-pw');
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'BAD_INVITE');
  res = await c.signup('invitee', 'long-enough-pw', { inviteCode: 'wrong' });
  assert.equal(res.status, 400);
  res = await c.signup('invitee', 'long-enough-pw', { inviteCode: 'let-me-in' });
  assert.equal(res.status, 201);
  await stopServer(server);
});

test('server logs never contain passwords or session tokens', () => {
  const output = servers.map((s) => s.output).join('\n');
  assert.ok(output.length > 0);
  for (const secret of secrets) assert.ok(!output.includes(secret), 'a secret leaked into the logs');
});
