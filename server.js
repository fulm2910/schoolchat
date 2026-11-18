'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

loadEnvFile(path.join(__dirname, '.env'));

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const bcrypt = require('bcryptjs');
const { openDb } = require('./db');
const { createFilter } = require('./lib/filter');
const { RateLimiter } = require('./lib/ratelimit');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimal .env loader (no extra dependency). Existing env vars win. */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const config = {
  port: Number.parseInt(process.env.PORT || '3000', 10),
  sessionDays: Number(process.env.SESSION_DAYS) > 0 ? Number(process.env.SESSION_DAYS) : 30,
  inviteCode: (process.env.INVITE_CODE || '').trim(),
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'chat.db'),
  trustProxy: (process.env.TRUST_PROXY || '').trim(),
  logRequests: process.env.LOG_REQUESTS !== '0',
};

const BCRYPT_COST = 12;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const ROOM_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,28}[\p{L}\p{N}_]$/u;
const MAX_MESSAGE_CHARS = 2000;
const HISTORY_PAGE = 100;
const MAX_ROOMS_PER_USER = 5;
const MAX_GROUPS_PER_USER = 20;
const MAX_GROUP_MEMBERS = 100;
const DUPLICATE_WINDOW_MS = 30_000;
const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_SOCKETS_PER_USER = 10;

const limiters = {
  signup: new RateLimiter({ windowMs: 60 * 60_000, max: 5 }), // per IP
  challenge: new RateLimiter({ windowMs: 10 * 60_000, max: 40 }), // per IP
  loginFailures: new RateLimiter({ windowMs: 15 * 60_000, max: 10 }), // per IP
  password: new RateLimiter({ windowMs: 15 * 60_000, max: 10 }), // per user
  message: new RateLimiter({ windowMs: 10_000, max: 10 }), // per user
  report: new RateLimiter({ windowMs: 60 * 60_000, max: 20 }), // per user
  create: new RateLimiter({ windowMs: 60 * 60_000, max: 30 }), // rooms/groups/DMs per user
  search: new RateLimiter({ windowMs: 60_000, max: 60 }), // per user
  wsFrames: new RateLimiter({ windowMs: 10_000, max: 60 }), // per user
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = openDb(config.dbPath);
const stmtCache = new Map();
/** Prepared-statement cache. All SQL goes through here with bound parameters. */
function sql(text) {
  let s = stmtCache.get(text);
  if (!s) stmtCache.set(text, (s = db.prepare(text)));
  return s;
}

const wordFilter = createFilter();
function reloadFilter() {
  wordFilter.setWords(sql('SELECT word FROM filter_words').all().map((r) => r.word));
}
reloadFilter();

// A real bcrypt hash used to keep login timing equal when the username does not exist.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

function toId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** Strip control characters (except newline/tab) and bidi overrides; normalise newlines. */
function cleanText(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

function cleanName(s) {
  return typeof s === 'string' ? cleanText(s).replace(/\s+/g, ' ').trim() : '';
}

function charLength(s) {
  return [...s].length;
}

function validatePassword(p) {
  if (typeof p !== 'string' || !p) return 'Password is required.';
  const len = charLength(p);
  if (len < 8 || len > 72) return 'Password must be 8 to 72 characters.';
  if (Buffer.byteLength(p, 'utf8') > 72) return 'Password is too long. Use 72 bytes or fewer (some symbols count as several).';
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    mustChangePassword: !!row.must_change_password,
  };
}

function formatMessage(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    username: r.username,
    body: r.body,
    createdAt: r.created_at,
  };
}

function hostMatches(originHeader, hostHeader) {
  if (!originHeader || !hostHeader) return false;
  try {
    return new URL(originHeader).host === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'sid';

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  sql('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, t, t + config.sessionDays * 86_400_000);
  return token;
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(config.sessionDays * 86_400)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function lookupSessionHash(hash) {
  const row = sql(`
    SELECT u.id, u.username, u.is_admin, u.is_banned, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash, now());
  if (!row || row.is_banned) return null;
  return row;
}

function sessionFromCookieHeader(header) {
  const token = parseCookies(header)[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const hash = sha256(token);
  const user = lookupSessionHash(hash);
  return user ? { hash, user } : null;
}

const pruneSessions = setInterval(() => {
  sql('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}, 60 * 60_000);
pruneSessions.unref();

// ---------------------------------------------------------------------------
// Signup challenge (simple server-generated arithmetic)
// ---------------------------------------------------------------------------

const challenges = new Map(); // id -> { answer, expires }

function newChallenge() {
  const t = now();
  if (challenges.size > 5000) {
    for (const [id, c] of challenges) if (c.expires < t) challenges.delete(id);
    while (challenges.size > 5000) challenges.delete(challenges.keys().next().value);
  }
  const kind = crypto.randomInt(3);
  let a = crypto.randomInt(2, 13);
  let b = crypto.randomInt(2, 13);
  let symbol, answer;
  if (kind === 0) { symbol = '+'; answer = a + b; }
  else if (kind === 1) { if (b > a) [a, b] = [b, a]; symbol = '-'; answer = a - b; }
  else { symbol = '×'; answer = a * b; }
  const id = crypto.randomBytes(16).toString('base64url');
  challenges.set(id, { answer: String(answer), expires: t + CHALLENGE_TTL_MS });
  return { id, question: `What is ${a} ${symbol} ${b}?` };
}

/** Single use: a challenge is consumed by any attempt, right or wrong. */
function verifyChallenge(id, answer) {
  if (typeof id !== 'string') return false;
  const c = challenges.get(id);
  if (!c) return false;
  challenges.delete(id);
  if (c.expires < now()) return false;
  return String(answer ?? '').trim() === c.answer;
}

// ---------------------------------------------------------------------------
// Live connections
// ---------------------------------------------------------------------------

const sockets = new Map(); // userId -> Set<WebSocket>

function sendWs(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sendToUser(userId, payload) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of set) sendWs(ws, data);
}

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const set of sockets.values()) for (const ws of set) sendWs(ws, data);
}

/**
 * Send to every member of a conversation. With `fromUserId`, members who have
 * blocked that user are skipped, so blocked content never reaches the blocker.
 */
function broadcastToConversation(conversationId, payload, { fromUserId, exceptUserId } = {}) {
  const rows = fromUserId
    ? sql(`SELECT user_id FROM members WHERE conversation_id = ?
           AND user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)`).all(conversationId, fromUserId)
    : sql('SELECT user_id FROM members WHERE conversation_id = ?').all(conversationId);
  const data = JSON.stringify(payload);
  for (const { user_id } of rows) if (user_id !== exceptUserId) sendToUser(user_id, data);
}

function closeSockets(predicate, reason = 'Session ended') {
  for (const set of sockets.values()) {
    for (const ws of set) {
      if (predicate(ws)) {
        sendWs(ws, { type: 'session_ended', reason });
        ws.close(4001, 'session ended');
      }
    }
  }
}

const closeUserSockets = (userId, reason) => closeSockets((ws) => ws.user.id === userId, reason);
const closeSessionSockets = (hash, reason) => closeSockets((ws) => ws.sessionHash === hash, reason);

function onlineUsers() {
  return [...sockets.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([id, set]) => ({ id, username: [...set][0].user.username }));
}

// ---------------------------------------------------------------------------
// Conversations and messages (shared by HTTP and WebSocket handlers)
// ---------------------------------------------------------------------------

const forbiddenConversation = () =>
  new HttpError(403, "You don't have access to this conversation.", 'FORBIDDEN');

function getMembership(userId, conversationId) {
  if (!conversationId) return null;
  return sql(`
    SELECT c.id, c.type, c.name, c.created_by, c.is_default, m.last_read_id
    FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
    WHERE c.id = ?`).get(userId, conversationId) || null;
}

function requireMembership(userId, conversationId) {
  const conv = getMembership(userId, conversationId);
  if (!conv) throw forbiddenConversation();
  return conv;
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.type, c.name, c.created_by AS createdBy, c.is_default AS isDefault,
    (SELECT MAX(x.created_at) FROM messages x WHERE x.conversation_id = c.id AND x.deleted_at IS NULL) AS lastMessageAt,
    (SELECT COUNT(*) FROM (
        SELECT 1 FROM messages x
        WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.deleted_at IS NULL
          AND x.user_id <> @uid
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = @uid AND b.blocked_id = x.user_id)
        LIMIT 100)) AS unread,
    (SELECT m2.user_id FROM members m2 WHERE c.type = 'dm' AND m2.conversation_id = c.id AND m2.user_id <> @uid) AS dmUserId,
    (SELECT u.username FROM members m2 JOIN users u ON u.id = m2.user_id
       WHERE c.type = 'dm' AND m2.conversation_id = c.id AND m2.user_id <> @uid) AS dmUsername,
    (SELECT COUNT(*) FROM members m3 WHERE m3.conversation_id = c.id) AS memberCount
  FROM members m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.user_id = @uid`;

function formatConversation(r) {
  return {
    id: r.id,
    type: r.type,
    name: r.type === 'dm' ? r.dmUsername : r.name,
    otherUser: r.type === 'dm' ? { id: r.dmUserId, username: r.dmUsername } : null,
    createdBy: r.createdBy,
    isDefault: !!r.isDefault,
    unread: r.unread,
    lastMessageAt: r.lastMessageAt,
    memberCount: r.memberCount,
  };
}

function listConversations(userId) {
  return sql(CONVERSATION_SELECT + ' ORDER BY c.type, c.name COLLATE NOCASE').all({ uid: userId }).map(formatConversation);
}

function getConversationFor(userId, conversationId) {
  const r = sql(CONVERSATION_SELECT + ' AND c.id = @cid').get({ uid: userId, cid: conversationId });
  return r ? formatConversation(r) : null;
}

function notifyConversationAdded(userId, conversationId) {
  const conversation = getConversationFor(userId, conversationId);
  if (conversation) sendToUser(userId, { type: 'conversation_added', conversation });
}

function isBlocking(blockerId, blockedId) {
  return !!sql('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId);
}

const lastMessageByUser = new Map(); // userId -> { key, at }

function sendMessage(user, conversationId, rawBody) {
  if (typeof rawBody !== 'string') throw new HttpError(400, 'Message must be text.', 'INVALID');
  const body = cleanText(rawBody).trim();
  if (!body) throw new HttpError(400, "Message can't be empty.", 'EMPTY');
  if (charLength(body) > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `Messages can be at most ${MAX_MESSAGE_CHARS} characters.`, 'TOO_LONG');
  }

  const conv = requireMembership(user.id, conversationId);

  if (!limiters.message.hit(String(user.id)).ok) {
    throw new HttpError(429, 'You are sending messages too quickly. Wait a few seconds and try again.', 'RATE_LIMITED');
  }
  if (wordFilter.check(body)) {
    throw new HttpError(400, 'Your message contains a word that is not allowed here. Edit it and try again.', 'FILTERED');
  }
  const key = body.toLowerCase().replace(/\s+/g, ' ');
  const last = lastMessageByUser.get(user.id);
  const t = now();
  if (last && last.key === key && t - last.at < DUPLICATE_WINDOW_MS) {
    throw new HttpError(429, 'You just sent that. Wait a moment before sending the same message again.', 'DUPLICATE');
  }

  const info = sql('INSERT INTO messages (conversation_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(conv.id, user.id, body, t);
  const message = {
    id: Number(info.lastInsertRowid), conversationId: conv.id, userId: user.id,
    username: user.username, body, createdAt: t,
  };
  lastMessageByUser.set(user.id, { key, at: t });
  sql('UPDATE members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?').run(message.id, conv.id, user.id);
  broadcastToConversation(conv.id, { type: 'message', message }, { fromUserId: user.id });
  return message;
}

function markRead(userId, conversationId, messageId) {
  if (!messageId) return;
  sql(`UPDATE members SET last_read_id = MAX(last_read_id, ?)
       WHERE conversation_id = ? AND user_id = ?`).run(messageId, conversationId, userId);
}

function addMember(conversationId, userId) {
  sql('INSERT OR IGNORE INTO members (conversation_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)')
    .run(conversationId, userId, now(),
      sql('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?').get(conversationId).id);
}

function removeMember(conversationId, userId) {
  sql('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(conversationId, userId);
}

function validateRoomName(raw) {
  const name = cleanName(raw);
  if (charLength(name) < 2 || charLength(name) > 30) throw new HttpError(400, 'Room names must be 2 to 30 characters.');
  if (!ROOM_NAME_RE.test(name)) {
    throw new HttpError(400, 'Room names can use letters, numbers, spaces, dashes and underscores.');
  }
  if (wordFilter.check(name)) throw new HttpError(400, 'That name contains a word that is not allowed here.', 'FILTERED');
  return name;
}

function validateGroupName(raw) {
  const name = cleanName(raw);
  if (charLength(name) < 2 || charLength(name) > 30) throw new HttpError(400, 'Group names must be 2 to 30 characters.');
  if (wordFilter.check(name)) throw new HttpError(400, 'That name contains a word that is not allowed here.', 'FILTERED');
  return name;
}

function findUserByName(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) return null;
  return sql('SELECT id, username, is_banned FROM users WHERE username = ?').get(username.trim()) || null;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) {
  const n = Number(config.trustProxy);
  app.set('trust proxy', Number.isInteger(n) ? n : config.trustProxy);
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Request log: method, path, status, duration. Never bodies, cookies or query strings.
if (config.logRequests) {
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log(req.method, req.path, res.statusCode, `${ms.toFixed(1)}ms`);
    });
    next();
  });
}

// CSRF defence in depth (cookies are already SameSite=Lax): reject cross-site state changes.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.' });
    if (req.headers.origin && !hostMatches(req.headers.origin, req.headers.host)) {
      return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
  }
  next();
});

app.use('/api', express.json({ limit: '32kb' }));

const route = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function authenticate({ allowPasswordChange = false } = {}) {
  return (req, res, next) => {
    const s = sessionFromCookieHeader(req.headers.cookie);
    if (!s) return res.status(401).json({ error: 'Please log in.', code: 'UNAUTHENTICATED' });
    req.user = publicUser(s.user);
    req.sessionHash = s.hash;
    if (req.user.mustChangePassword && !allowPasswordChange) {
      return res.status(403).json({ error: 'Set a new password to continue.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    next();
  };
}
const requireUser = authenticate();
const requireUserOrReset = authenticate({ allowPasswordChange: true });

function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admins only.', code: 'FORBIDDEN' });
  next();
}

// --- Public ---------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({ inviteRequired: !!config.inviteCode, maxMessageLength: MAX_MESSAGE_CHARS });
});

app.get('/api/challenge', (req, res) => {
  if (!limiters.challenge.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  res.json(newChallenge());
});

app.post('/api/signup', route(async (req, res) => {
  if (!limiters.signup.hit(req.ip).ok) {
    throw new HttpError(429, 'Too many signups from your network. Try again later.', 'RATE_LIMITED');
  }
  const { username, password, challengeId, answer, inviteCode, website } = body(req);

  if (website) throw new HttpError(400, 'Signup failed.'); // honeypot field, invisible to people

  const name = typeof username === 'string' ? username.trim() : '';
  if (!USERNAME_RE.test(name)) {
    throw new HttpError(400, 'Usernames must be 3 to 20 characters: letters, numbers and underscores.', 'INVALID_USERNAME');
  }
  const pwError = validatePassword(password);
  if (pwError) throw new HttpError(400, pwError, 'INVALID_PASSWORD');

  if (!verifyChallenge(challengeId, answer)) {
    throw new HttpError(400, "That answer wasn't right. Here's a new question.", 'BAD_CHALLENGE');
  }
  if (config.inviteCode && !safeEqual(typeof inviteCode === 'string' ? inviteCode.trim() : '', config.inviteCode)) {
    throw new HttpError(400, 'That invite code is not valid.', 'BAD_INVITE');
  }
  if (wordFilter.check(name.replace(/_/g, ' '))) {
    throw new HttpError(400, 'That username is not allowed.', 'INVALID_USERNAME');
  }
  if (sql('SELECT 1 FROM users WHERE username = ?').get(name)) {
    throw new HttpError(409, 'That username is taken.', 'USERNAME_TAKEN');
  }

  const hash = await bcrypt.hash(password, BCRYPT_COST);

  const user = db.transaction(() => {
    if (sql('SELECT 1 FROM users WHERE username = ?').get(name)) return null; // lost a race
    const isFirst = sql('SELECT COUNT(*) AS n FROM users').get().n === 0;
    const info = sql('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hash, isFirst ? 1 : 0, now());
    const id = Number(info.lastInsertRowid);
    for (const room of sql("SELECT id FROM conversations WHERE type = 'room' AND is_default = 1").all()) addMember(room.id, id);
    return sql('SELECT * FROM users WHERE id = ?').get(id);
  })();
  if (!user) throw new HttpError(409, 'That username is taken.', 'USERNAME_TAKEN');

  setSessionCookie(req, res, createSession(user.id));
  log('signup', `user=${user.id}`, user.is_admin ? '(first account, admin)' : '');
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/login', route(async (req, res) => {
  const ip = req.ip;
  if (!limiters.loginFailures.check(ip).ok) {
    throw new HttpError(429, 'Too many failed login attempts. Try again in a few minutes.', 'RATE_LIMITED');
  }
  const { username, password } = body(req);
  const name = typeof username === 'string' ? username.trim() : '';
  const pw = typeof password === 'string' ? password : '';
  const user = USERNAME_RE.test(name) ? sql('SELECT * FROM users WHERE username = ?').get(name) : null;
  const passwordUsable = pw.length > 0 && Buffer.byteLength(pw, 'utf8') <= 72;

  // Always run one bcrypt comparison so a missing user takes as long as a wrong password.
  const ok = await bcrypt.compare(passwordUsable ? pw : 'x', user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordUsable || !ok) {
    limiters.loginFailures.hit(ip);
    throw new HttpError(401, 'Incorrect username or password.', 'BAD_CREDENTIALS');
  }
  if (user.is_banned) throw new HttpError(403, 'This account has been suspended.', 'BANNED');

  setSessionCookie(req, res, createSession(user.id));
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token && token.length <= 128) {
    const hash = sha256(token);
    sql('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    closeSessionSockets(hash, 'Logged out');
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// --- Account (allowed while a password change is pending) -----------------

app.get('/api/me', requireUserOrReset, (req, res) => res.json({ user: req.user }));

app.post('/api/logout-all', requireUserOrReset, (req, res) => {
  sql('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  closeUserSockets(req.user.id, 'Logged out everywhere');
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/password', requireUserOrReset, route(async (req, res) => {
  if (!limiters.password.hit(String(req.user.id)).ok) {
    throw new HttpError(429, 'Too many attempts. Try again later.', 'RATE_LIMITED');
  }
  const { currentPassword, newPassword } = body(req);
  const row = sql('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const current = typeof currentPassword === 'string' ? currentPassword : '';
  if (!current || Buffer.byteLength(current, 'utf8') > 72 || !(await bcrypt.compare(current, row.password_hash))) {
    throw new HttpError(400, 'Your current password is incorrect.', 'BAD_CREDENTIALS');
  }
  const pwError = validatePassword(newPassword);
  if (pwError) throw new HttpError(400, pwError, 'INVALID_PASSWORD');
  if (newPassword === current) throw new HttpError(400, 'Choose a password different from your current one.', 'INVALID_PASSWORD');

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  sql('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, req.user.id);
  // Sign out every other device.
  sql('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sessionHash);
  closeSockets((ws) => ws.user.id === req.user.id && ws.sessionHash !== req.sessionHash, 'Password changed');
  res.json({ user: { ...req.user, mustChangePassword: false } });
}));

// --- Everything below requires a full session ------------------------------

app.get('/api/conversations', requireUser, (req, res) => {
  res.json({ conversations: listConversations(req.user.id) });
});

app.get('/api/online', requireUser, (req, res) => res.json({ users: onlineUsers() }));

app.get('/api/conversations/:id/messages', requireUser, route((req, res) => {
  const conv = requireMembership(req.user.id, toId(req.params.id));
  const before = toId(req.query.before);
  const rows = sql(`
    SELECT m.id, m.conversation_id, m.user_id, u.username, m.body, m.created_at
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = @cid AND m.deleted_at IS NULL AND m.id < @before
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = @uid AND b.blocked_id = m.user_id)
    ORDER BY m.id DESC LIMIT @limit`).all({
    cid: conv.id, uid: req.user.id, before: before || Number.MAX_SAFE_INTEGER, limit: HISTORY_PAGE + 1,
  });
  const hasMore = rows.length > HISTORY_PAGE;
  if (hasMore) rows.pop();
  rows.reverse();
  if (!before) {
    const latest = sql('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conv.id).id;
    markRead(req.user.id, conv.id, latest);
  }
  res.json({ messages: rows.map(formatMessage), hasMore });
}));

app.post('/api/conversations/:id/messages', requireUser, route((req, res) => {
  const message = sendMessage(req.user, toId(req.params.id), body(req).body);
  res.status(201).json({ message });
}));

app.post('/api/conversations/:id/read', requireUser, route((req, res) => {
  const conv = requireMembership(req.user.id, toId(req.params.id));
  markRead(req.user.id, conv.id, toId(body(req).messageId));
  res.json({ ok: true });
}));

app.get('/api/conversations/:id/members', requireUser, route((req, res) => {
  const conv = requireMembership(req.user.id, toId(req.params.id));
  const members = sql(`
    SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ? AND u.is_banned = 0 ORDER BY u.username COLLATE NOCASE LIMIT 500`).all(conv.id);
  res.json({
    members: members.map((m) => ({ ...m, online: sockets.has(m.id) })),
    createdBy: conv.created_by,
    type: conv.type,
  });
}));

// Messages: delete and report

app.delete('/api/messages/:id', requireUser, route((req, res) => {
  const msg = sql('SELECT id, conversation_id, user_id FROM messages WHERE id = ? AND deleted_at IS NULL').get(toId(req.params.id));
  if (!msg) throw new HttpError(404, 'Message not found.');
  if (!req.user.isAdmin) {
    if (msg.user_id !== req.user.id) throw new HttpError(403, 'You can only delete your own messages.');
    requireMembership(req.user.id, msg.conversation_id);
  }
  const t = now();
  sql('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(t, req.user.id, msg.id);
  if (req.user.isAdmin) {
    sql(`UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE message_id = ? AND status = 'open'`)
      .run(req.user.id, t, msg.id);
    if (msg.user_id !== req.user.id) log('admin', `user=${req.user.id}`, 'deleted message', msg.id);
  }
  broadcastToConversation(msg.conversation_id, { type: 'message_deleted', conversationId: msg.conversation_id, messageId: msg.id });
  res.json({ ok: true });
}));

app.post('/api/messages/:id/report', requireUser, route((req, res) => {
  const msg = sql('SELECT id, conversation_id, user_id FROM messages WHERE id = ? AND deleted_at IS NULL').get(toId(req.params.id));
  if (!msg || !getMembership(req.user.id, msg.conversation_id)) throw new HttpError(404, 'Message not found.');
  if (msg.user_id === req.user.id) throw new HttpError(400, "You can't report your own message.");
  if (!limiters.report.hit(String(req.user.id)).ok) throw new HttpError(429, 'Too many reports. Try again later.', 'RATE_LIMITED');
  const raw = body(req).reason;
  const reason = typeof raw === 'string' ? cleanText(raw).trim() : '';
  if (charLength(reason) > 500) throw new HttpError(400, 'Keep the reason under 500 characters.');
  if (sql('SELECT 1 FROM reports WHERE message_id = ? AND reporter_id = ?').get(msg.id, req.user.id)) {
    throw new HttpError(409, "You've already reported this message.");
  }
  sql('INSERT INTO reports (message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)').run(msg.id, req.user.id, reason, now());
  res.status(201).json({ ok: true });
}));

// Rooms

app.get('/api/rooms', requireUser, (req, res) => {
  const rooms = sql(`
    SELECT c.id, c.name, c.is_default AS isDefault, c.created_by AS createdBy,
      (SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id) AS memberCount,
      EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?) AS joined
    FROM conversations c WHERE c.type = 'room'
    ORDER BY c.is_default DESC, memberCount DESC, c.name COLLATE NOCASE LIMIT 300`).all(req.user.id);
  const created = sql("SELECT COUNT(*) AS n FROM conversations WHERE type = 'room' AND created_by = ?").get(req.user.id).n;
  res.json({
    rooms: rooms.map((r) => ({ ...r, isDefault: !!r.isDefault, joined: !!r.joined })),
    createdCount: created,
    maxCreated: MAX_ROOMS_PER_USER,
  });
});

app.post('/api/rooms', requireUser, route((req, res) => {
  const name = validateRoomName(body(req).name);
  const created = sql("SELECT COUNT(*) AS n FROM conversations WHERE type = 'room' AND created_by = ?").get(req.user.id).n;
  if (created >= MAX_ROOMS_PER_USER) throw new HttpError(400, `You can create up to ${MAX_ROOMS_PER_USER} rooms.`, 'LIMIT');
  if (sql("SELECT 1 FROM conversations WHERE type = 'room' AND name = ?").get(name)) {
    throw new HttpError(409, 'A room with that name already exists.');
  }
  if (!limiters.create.hit(String(req.user.id)).ok) throw new HttpError(429, 'Slow down a little.', 'RATE_LIMITED');
  const id = db.transaction(() => {
    const info = sql("INSERT INTO conversations (type, name, created_by, created_at) VALUES ('room', ?, ?, ?)").run(name, req.user.id, now());
    const cid = Number(info.lastInsertRowid);
    addMember(cid, req.user.id);
    return cid;
  })();
  res.status(201).json({ conversation: getConversationFor(req.user.id, id) });
}));

app.post('/api/rooms/:id/join', requireUser, route((req, res) => {
  const room = sql("SELECT id FROM conversations WHERE id = ? AND type = 'room'").get(toId(req.params.id));
  if (!room) throw new HttpError(404, 'Room not found.');
  addMember(room.id, req.user.id);
  res.json({ conversation: getConversationFor(req.user.id, room.id) });
}));

app.post('/api/rooms/:id/leave', requireUser, route((req, res) => {
  const conv = requireMembership(req.user.id, toId(req.params.id));
  if (conv.type !== 'room') throw new HttpError(400, 'Not a room.');
  removeMember(conv.id, req.user.id);
  res.json({ ok: true });
}));

// Direct messages

app.post('/api/dms', requireUser, route((req, res) => {
  const { username, userId } = body(req);
  const target = userId
    ? sql('SELECT id, username, is_banned FROM users WHERE id = ?').get(toId(userId))
    : findUserByName(username);
  if (!target || target.is_banned) throw new HttpError(404, 'User not found.');
  if (target.id === req.user.id) throw new HttpError(400, "You can't message yourself.");

  const key = [req.user.id, target.id].sort((a, b) => a - b).join(':');
  const existing = sql("SELECT id FROM conversations WHERE type = 'dm' AND dm_key = ?").get(key);
  if (existing) return res.json({ conversation: getConversationFor(req.user.id, existing.id) });

  if (isBlocking(req.user.id, target.id)) throw new HttpError(400, 'Unblock this user to message them.', 'BLOCKED');
  if (isBlocking(target.id, req.user.id)) throw new HttpError(403, "You can't start a conversation with this user.", 'NOT_ALLOWED');
  if (!limiters.create.hit(String(req.user.id)).ok) throw new HttpError(429, 'Slow down a little.', 'RATE_LIMITED');

  const id = db.transaction(() => {
    const info = sql("INSERT INTO conversations (type, dm_key, created_by, created_at) VALUES ('dm', ?, ?, ?)").run(key, req.user.id, now());
    const cid = Number(info.lastInsertRowid);
    addMember(cid, req.user.id);
    addMember(cid, target.id);
    return cid;
  })();
  notifyConversationAdded(target.id, id);
  res.status(201).json({ conversation: getConversationFor(req.user.id, id) });
}));

// Private groups

function requireGroup(userId, conversationId) {
  const conv = requireMembership(userId, conversationId);
  if (conv.type !== 'group') throw new HttpError(400, 'Not a group.');
  return conv;
}

function memberCount(conversationId) {
  return sql('SELECT COUNT(*) AS n FROM members WHERE conversation_id = ?').get(conversationId).n;
}

/** Returns null on success or a short reason. Never reveals that the target blocked the inviter. */
function canInvite(inviterId, target, conversationId) {
  if (!target || target.is_banned) return 'not found';
  if (target.id === inviterId) return 'already a member';
  if (getMembership(target.id, conversationId)) return 'already a member';
  if (isBlocking(target.id, inviterId) || isBlocking(inviterId, target.id)) return "couldn't be added";
  return null;
}

app.post('/api/groups', requireUser, route((req, res) => {
  const { name: rawName, members } = body(req);
  const name = validateGroupName(rawName);
  const created = sql("SELECT COUNT(*) AS n FROM conversations WHERE type = 'group' AND created_by = ?").get(req.user.id).n;
  if (created >= MAX_GROUPS_PER_USER) throw new HttpError(400, `You can create up to ${MAX_GROUPS_PER_USER} groups.`, 'LIMIT');
  if (!limiters.create.hit(String(req.user.id)).ok) throw new HttpError(429, 'Slow down a little.', 'RATE_LIMITED');
  const wanted = Array.isArray(members) ? [...new Set(members.filter((m) => typeof m === 'string').map((m) => m.trim()))].slice(0, MAX_GROUP_MEMBERS - 1) : [];

  const notAdded = [];
  const added = [];
  const id = db.transaction(() => {
    const info = sql("INSERT INTO conversations (type, name, created_by, created_at) VALUES ('group', ?, ?, ?)").run(name, req.user.id, now());
    const cid = Number(info.lastInsertRowid);
    addMember(cid, req.user.id);
    for (const uname of wanted) {
      const target = findUserByName(uname);
      const problem = canInvite(req.user.id, target, cid);
      if (problem) { notAdded.push({ username: uname, reason: problem }); continue; }
      addMember(cid, target.id);
      added.push(target.id);
    }
    return cid;
  })();
  for (const uid of added) notifyConversationAdded(uid, id);
  res.status(201).json({ conversation: getConversationFor(req.user.id, id), notAdded });
}));

app.post('/api/groups/:id/members', requireUser, route((req, res) => {
  const conv = requireGroup(req.user.id, toId(req.params.id));
  if (conv.created_by !== req.user.id) throw new HttpError(403, 'Only the group creator can add members.');
  if (memberCount(conv.id) >= MAX_GROUP_MEMBERS) throw new HttpError(400, `Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
  const target = findUserByName(body(req).username);
  const problem = canInvite(req.user.id, target, conv.id);
  if (problem === 'not found') throw new HttpError(404, 'User not found.');
  if (problem === 'already a member') throw new HttpError(409, 'That user is already in this group.');
  if (problem) throw new HttpError(400, "Couldn't add that user.", 'NOT_ALLOWED');
  addMember(conv.id, target.id);
  notifyConversationAdded(target.id, conv.id);
  broadcastToConversation(conv.id, { type: 'members_changed', conversationId: conv.id });
  res.status(201).json({ ok: true, user: { id: target.id, username: target.username } });
}));

app.delete('/api/groups/:id/members/:userId', requireUser, route((req, res) => {
  const conv = requireGroup(req.user.id, toId(req.params.id));
  if (conv.created_by !== req.user.id) throw new HttpError(403, 'Only the group creator can remove members.');
  const targetId = toId(req.params.userId);
  if (targetId === req.user.id) throw new HttpError(400, 'Use "Leave group" to leave.');
  if (!getMembership(targetId, conv.id)) throw new HttpError(404, 'That user is not in this group.');
  removeMember(conv.id, targetId);
  sendToUser(targetId, { type: 'conversation_removed', conversationId: conv.id, reason: 'You were removed from this group.' });
  broadcastToConversation(conv.id, { type: 'members_changed', conversationId: conv.id });
  res.json({ ok: true });
}));

app.post('/api/groups/:id/leave', requireUser, route((req, res) => {
  const conv = requireGroup(req.user.id, toId(req.params.id));
  db.transaction(() => {
    removeMember(conv.id, req.user.id);
    if (conv.created_by === req.user.id) {
      const heir = sql('SELECT user_id FROM members WHERE conversation_id = ? ORDER BY joined_at, user_id LIMIT 1').get(conv.id);
      if (heir) sql('UPDATE conversations SET created_by = ? WHERE id = ?').run(heir.user_id, conv.id);
      else sql('DELETE FROM conversations WHERE id = ?').run(conv.id);
    }
  })();
  broadcastToConversation(conv.id, { type: 'members_changed', conversationId: conv.id });
  res.json({ ok: true });
}));

// Users and blocks

app.get('/api/users/search', requireUser, route((req, res) => {
  if (!limiters.search.hit(String(req.user.id)).ok) throw new HttpError(429, 'Slow down a little.', 'RATE_LIMITED');
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q || q.length > 20 || !/^[A-Za-z0-9_]+$/.test(q)) return res.json({ users: [] });
  const users = sql(`
    SELECT id, username FROM users
    WHERE username LIKE ? ESCAPE '\\' AND id <> ? AND is_banned = 0
    ORDER BY (username LIKE ? ESCAPE '\\') DESC, length(username), username COLLATE NOCASE LIMIT 10`)
    .all(`%${escapeLike(q)}%`, req.user.id, `${escapeLike(q)}%`);
  res.json({ users: users.map((u) => ({ ...u, online: sockets.has(u.id) })) });
}));

app.get('/api/blocks', requireUser, (req, res) => {
  const users = sql(`SELECT u.id, u.username FROM blocks b JOIN users u ON u.id = b.blocked_id
                     WHERE b.blocker_id = ? ORDER BY u.username COLLATE NOCASE`).all(req.user.id);
  res.json({ users });
});

app.post('/api/blocks', requireUser, route((req, res) => {
  const { userId, username } = body(req);
  const target = userId ? sql('SELECT id, username FROM users WHERE id = ?').get(toId(userId)) : findUserByName(username);
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.id === req.user.id) throw new HttpError(400, "You can't block yourself.");
  sql('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(req.user.id, target.id, now());
  res.status(201).json({ ok: true, user: { id: target.id, username: target.username } });
}));

app.delete('/api/blocks/:userId', requireUser, route((req, res) => {
  sql('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, toId(req.params.userId));
  res.json({ ok: true });
}));

// --- Admin -----------------------------------------------------------------

app.use('/api/admin', requireUser, requireAdmin);

app.get('/api/admin/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const reports = sql(`
    SELECT r.id, r.reason, r.status, r.created_at AS createdAt, r.message_id AS messageId,
      rep.id AS reporterId, rep.username AS reporterName,
      m.body, m.created_at AS messageCreatedAt, m.deleted_at AS messageDeletedAt, m.conversation_id AS conversationId,
      au.id AS authorId, au.username AS authorName, au.is_banned AS authorBanned,
      c.type AS conversationType, c.name AS conversationName
    FROM reports r
    JOIN messages m ON m.id = r.message_id
    JOIN users rep ON rep.id = r.reporter_id
    JOIN users au ON au.id = m.user_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE r.status = ? ORDER BY r.id DESC LIMIT 100`).all(status);

  const ctxSql = (dir) => `
    SELECT m.id, m.user_id AS userId, u.username, m.body, m.created_at AS createdAt, m.deleted_at IS NOT NULL AS deleted
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ? AND m.id ${dir === 'before' ? '<' : '>'} ?
    ORDER BY m.id ${dir === 'before' ? 'DESC' : 'ASC'} LIMIT 4`;

  for (const r of reports) {
    r.authorBanned = !!r.authorBanned;
    r.messageDeleted = !!r.messageDeletedAt;
    const before = sql(ctxSql('before')).all(r.conversationId, r.messageId).reverse();
    const after = sql(ctxSql('after')).all(r.conversationId, r.messageId);
    r.context = [
      ...before,
      { id: r.messageId, userId: r.authorId, username: r.authorName, body: r.body, createdAt: r.messageCreatedAt, deleted: r.messageDeleted, reported: true },
      ...after,
    ].map((m) => ({ ...m, deleted: !!m.deleted }));
    if (r.conversationType === 'dm') {
      r.conversationName = sql(`SELECT group_concat(u.username, ' & ') AS n FROM members m JOIN users u ON u.id = m.user_id
                                WHERE m.conversation_id = ?`).get(r.conversationId).n;
    }
  }
  res.json({ reports });
});

app.post('/api/admin/reports/:id/resolve', route((req, res) => {
  const status = body(req).status === 'dismissed' ? 'dismissed' : 'resolved';
  const info = sql('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(status, req.user.id, now(), toId(req.params.id));
  if (!info.changes) throw new HttpError(404, 'Report not found.');
  res.json({ ok: true });
}));

app.get('/api/admin/users', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 20) : '';
  const users = sql(`
    SELECT id, username, is_admin AS isAdmin, is_banned AS isBanned, must_change_password AS mustChangePassword,
      created_at AS createdAt, (SELECT COUNT(*) FROM messages WHERE user_id = users.id AND deleted_at IS NULL) AS messageCount
    FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100`).all(`%${escapeLike(q)}%`);
  res.json({
    users: users.map((u) => ({
      ...u, isAdmin: !!u.isAdmin, isBanned: !!u.isBanned, mustChangePassword: !!u.mustChangePassword, online: sockets.has(u.id),
    })),
  });
});

function adminTarget(req) {
  const target = sql('SELECT * FROM users WHERE id = ?').get(toId(req.params.id));
  if (!target) throw new HttpError(404, 'User not found.');
  return target;
}

app.post('/api/admin/users/:id/ban', route((req, res) => {
  const target = adminTarget(req);
  if (target.id === req.user.id) throw new HttpError(400, "You can't ban yourself.");
  sql('UPDATE users SET is_banned = 1 WHERE id = ?').run(target.id);
  sql('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  closeUserSockets(target.id, 'Your account has been suspended.');
  log('admin', `user=${req.user.id}`, 'banned', `user=${target.id}`);
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/unban', route((req, res) => {
  const target = adminTarget(req);
  sql('UPDATE users SET is_banned = 0 WHERE id = ?').run(target.id);
  log('admin', `user=${req.user.id}`, 'unbanned', `user=${target.id}`);
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/promote', route((req, res) => {
  const target = adminTarget(req);
  if (target.is_banned) throw new HttpError(400, 'Unban this user first.');
  sql('UPDATE users SET is_admin = 1 WHERE id = ?').run(target.id);
  log('admin', `user=${req.user.id}`, 'promoted', `user=${target.id}`);
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/reset-password', route(async (req, res) => {
  const target = adminTarget(req);
  if (target.id === req.user.id) throw new HttpError(400, 'Use "Change password" for your own account.');
  const { password } = body(req);
  const pwError = validatePassword(password);
  if (pwError) throw new HttpError(400, pwError, 'INVALID_PASSWORD');
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  sql('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, target.id);
  sql('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  closeUserSockets(target.id, 'Your password was reset by an admin.');
  log('admin', `user=${req.user.id}`, 'reset password for', `user=${target.id}`);
  res.json({ ok: true });
}));

app.get('/api/admin/filter', (req, res) => {
  res.json({ words: sql('SELECT id, word, created_at AS createdAt FROM filter_words ORDER BY word COLLATE NOCASE').all() });
});

app.post('/api/admin/filter', route((req, res) => {
  const raw = body(req).word;
  const word = typeof raw === 'string' ? cleanName(raw).toLowerCase() : '';
  if (charLength(word) < 2 || charLength(word) > 50) throw new HttpError(400, 'Words must be 2 to 50 characters.');
  if (sql('SELECT 1 FROM filter_words WHERE word = ?').get(word)) throw new HttpError(409, 'That word is already on the list.');
  const info = sql('INSERT INTO filter_words (word, created_by, created_at) VALUES (?, ?, ?)').run(word, req.user.id, now());
  reloadFilter();
  res.status(201).json({ word: { id: Number(info.lastInsertRowid), word } });
}));

app.delete('/api/admin/filter/:id', route((req, res) => {
  sql('DELETE FROM filter_words WHERE id = ?').run(toId(req.params.id));
  reloadFilter();
  res.json({ ok: true });
}));

// --- Static files and errors ----------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, file) {
    res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
  },
}));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  // Log the stack only: parse errors carry the raw request body, which may contain a password.
  console.error(new Date().toISOString(), 'Unhandled error:', err && err.stack ? err.stack : String(err));
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return reject(400, 'Bad Request'); }
  if (pathname !== '/ws') return reject(404, 'Not Found');
  if (!hostMatches(req.headers.origin, req.headers.host)) return reject(403, 'Forbidden');
  const session = sessionFromCookieHeader(req.headers.cookie);
  if (!session) return reject(401, 'Unauthorized');
  if (session.user.must_change_password) return reject(403, 'Forbidden');
  const existing = sockets.get(session.user.id);
  if (existing && existing.size >= MAX_SOCKETS_PER_USER) return reject(429, 'Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session));
});

function onConnection(ws, session) {
  ws.user = { id: session.user.id, username: session.user.username };
  ws.sessionHash = session.hash;
  ws.isAlive = true;

  let set = sockets.get(ws.user.id);
  const firstSocket = !set;
  if (!set) sockets.set(ws.user.id, (set = new Set()));
  set.add(ws);
  if (firstSocket) broadcastAll({ type: 'presence', user: ws.user, online: true });

  sendWs(ws, { type: 'hello', user: publicUser(session.user), online: onlineUsers() });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => handleSocketMessage(ws, data, isBinary));
  ws.on('error', () => {});
  ws.on('close', () => {
    const s = sockets.get(ws.user.id);
    if (!s) return;
    s.delete(ws);
    if (s.size === 0) {
      sockets.delete(ws.user.id);
      broadcastAll({ type: 'presence', user: ws.user, online: false });
    }
  });
}

const typingSent = new Map(); // "uid:cid" -> timestamp

function handleSocketMessage(ws, data, isBinary) {
  if (isBinary) return;
  // Re-validate the session on every frame: logout, bans and resets take effect immediately.
  const user = lookupSessionHash(ws.sessionHash);
  if (!user || user.must_change_password) {
    sendWs(ws, { type: 'session_ended', reason: 'Session ended' });
    return ws.close(4001, 'session ended');
  }
  if (!limiters.wsFrames.hit(String(user.id)).ok) return sendWs(ws, { type: 'error', error: 'Slow down a little.' });

  let msg;
  try { msg = JSON.parse(data.toString('utf8')); } catch { return sendWs(ws, { type: 'error', error: 'Invalid message.' }); }
  if (!msg || typeof msg !== 'object') return;
  const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : undefined;
  const conversationId = toId(msg.conversationId);
  const actor = { id: user.id, username: user.username, isAdmin: !!user.is_admin };

  switch (msg.type) {
    case 'send': {
      try {
        const message = sendMessage(actor, conversationId, msg.body);
        sendWs(ws, { type: 'ack', clientId, messageId: message.id });
      } catch (err) {
        if (!(err instanceof HttpError)) {
          console.error(new Date().toISOString(), 'Socket send failed:', err && err.stack ? err.stack : String(err));
        }
        sendWs(ws, {
          type: 'error', clientId, conversationId,
          error: err instanceof HttpError ? err.message : 'Something went wrong.',
          code: err instanceof HttpError ? err.code : 'SERVER_ERROR',
        });
      }
      break;
    }
    case 'typing': {
      if (!getMembership(user.id, conversationId)) return;
      const key = `${user.id}:${conversationId}`;
      const t = now();
      if (t - (typingSent.get(key) || 0) < 1500) return;
      typingSent.set(key, t);
      broadcastToConversation(conversationId, {
        type: 'typing', conversationId, user: { id: user.id, username: user.username },
      }, { fromUserId: user.id, exceptUserId: user.id });
      break;
    }
    case 'read': {
      if (!getMembership(user.id, conversationId)) return;
      markRead(user.id, conversationId, toId(msg.messageId));
      break;
    }
    case 'ping':
      sendWs(ws, { type: 'pong' });
      break;
    default:
      sendWs(ws, { type: 'error', error: 'Unknown message type.' });
  }
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const cutoff = now() - 60_000;
  for (const [k, t] of typingSent) if (t < cutoff) typingSent.delete(k);
  for (const [k, v] of lastMessageByUser) if (v.at < now() - DUPLICATE_WINDOW_MS) lastMessageByUser.delete(k);
}, 30_000);
heartbeat.unref();

function shutdown() {
  log('shutting down');
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(config.port, () => {
  log(`schoolchat listening on http://localhost:${server.address().port}`);
  if (config.inviteCode) log('Invite code required for signup.');
});

module.exports = { app, server };
