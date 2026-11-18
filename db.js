'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Schema is idempotent: it is applied on every start and only creates what is missing.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT    NOT NULL,
  is_admin             INTEGER NOT NULL DEFAULT 0,
  is_banned            INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,           -- SHA-256 of the cookie token; the token itself is never stored
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- One table for every kind of conversation: public rooms, private groups and DMs.
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL CHECK (type IN ('room', 'group', 'dm')),
  name       TEXT    COLLATE NOCASE,
  dm_key     TEXT    UNIQUE,                -- "<lowId>:<highId>" for DMs, NULL otherwise
  is_default INTEGER NOT NULL DEFAULT 0,    -- default rooms are joined automatically at signup
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_name ON conversations(name) WHERE type = 'room';
CREATE INDEX IF NOT EXISTS idx_conversations_creator ON conversations(created_by, type);

CREATE TABLE IF NOT EXISTS members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       INTEGER NOT NULL,
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  body            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by      INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  INTEGER NOT NULL,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at INTEGER,
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS filter_words (
  id         INTEGER PRIMARY KEY,
  word       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
`;

const DEFAULT_ROOMS = ['general', 'random'];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  const find = db.prepare("SELECT id FROM conversations WHERE type = 'room' AND name = ?");
  const insert = db.prepare(
    "INSERT INTO conversations (type, name, is_default, created_at) VALUES ('room', ?, 1, ?)"
  );
  db.transaction(() => {
    for (const name of DEFAULT_ROOMS) if (!find.get(name)) insert.run(name, Date.now());
  })();

  return db;
}

module.exports = { openDb, DEFAULT_ROOMS };
