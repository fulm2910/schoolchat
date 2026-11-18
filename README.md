# schoolchat

A small, self-hosted, real-time chat app for a niche community. It has public rooms, direct messages, private groups and moderation tools. It's a single Node.js process with one SQLite file and no frontend framework.

- **Server:** Node 20+, Express, `ws`, `better-sqlite3`, `bcryptjs`
- **Client:** vanilla HTML, CSS and JS in `public/`. Supports light and dark mode and works on phones and laptops.

## Run it locally

```bash
npm install
cp .env.example .env     # optional
npm start
```

Open http://localhost:3000. **The first account you create becomes the admin.**

To run the tests:

```bash
npm test
```

The tests start a real server on a free port with a throwaway database, then cover signup and login, room messages, DMs, group membership, blocking, the word filter, reports, bans, admin password reset, rate limits, WebSocket origin checks and log hygiene.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `SESSION_DAYS` | `30` | How long a login lasts |
| `INVITE_CODE` | *(empty)* | When set, signup requires this code |
| `DB_PATH` | `./data/chat.db` | SQLite file location. Put it on a persistent disk in production. |
| `TRUST_PROXY` | *(unset)* | Set to `1` behind a single reverse proxy (Render, Fly.io) |
| `LOG_REQUESTS` | `1` | Set to `0` to turn off the access log |

Values in `.env` are loaded at startup. Real environment variables take precedence.

## Features

**Accounts**
- Username and password only, with no email. Usernames are 3–20 letters, digits or `_`, unique regardless of case. Passwords are 8–72 characters, hashed with bcrypt at cost 12.
- Signup has a server-generated math question (single use, expires after 10 minutes), a hidden honeypot field, per-IP rate limits and an optional invite code.
- Sessions use a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie, with `Secure` added over HTTPS. Only its SHA-256 hash is stored, with an expiry.
- You can log out, or log out everywhere. Changing your password requires the current one and signs out your other devices.
- There's no self-service reset. An admin sets a temporary password, and the user has to choose a new one at their next login.

**Conversations**
- Public rooms: `general` and `random` are created on first run and every new user joins them. Anyone can browse, join and leave rooms, and each user can create up to 5.
- Direct messages: find people with the search box in the sidebar.
- Private groups: the creator invites people by username and can remove members. Members can leave. If the creator leaves, ownership passes to the longest-standing member.
- Live delivery over WebSockets, plus online status, typing indicators, unread badges, the last 100 messages on open and older pages as you scroll up.
- Messages are 1–2000 characters. Enter sends, Shift+Enter adds a new line, and links are clickable.

**Moderation**
- Anyone can delete their own messages and report any message, with an optional reason.
- The admin dashboard is at `/admin`. It shows reports with the surrounding messages, and lets admins delete any message, ban or unban users (a ban ends their sessions and open sockets immediately), reset passwords, promote other admins and edit the word filter.
- Word filter: entries match whole words and phrases after folding case, accents, invisible characters and common substitutions (`0→o`, `1/l/!→i`, `3→e`, `4/@→a`, `5/$→s`, `7→t`). Spaced-out letters (`b a d`) are joined before matching. Usernames and room or group names are checked too.
- Blocking is private. Blocked users' messages and typing are hidden from you everywhere, and they can't start a DM with you or add you to a group. They aren't told.

## Security notes

- Membership is checked on the server for every read, send, typing event and read receipt, over both HTTP and WebSocket.
- WebSocket upgrades need a valid session cookie and an `Origin` that matches `Host`. The session is checked again on every frame, so logout, bans and password resets take effect immediately.
- State-changing API calls with a cross-site `Origin` or `Sec-Fetch-Site: cross-site` are rejected. This is a second layer of CSRF protection on top of `SameSite=Lax`.
- All SQL uses bound parameters.
- The client renders user content with `textContent` and text nodes only. A test checks that the frontend contains no `innerHTML`.
- Security headers are set by hand: a strict CSP (`default-src 'none'`, scripts and styles from `'self'` only, no inline code), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, COOP/CORP, `Permissions-Policy`, and HSTS over HTTPS.
- Rate limits: signups (5 per hour per IP), failed logins (10 per 15 minutes per IP), messages (10 per 10 seconds per user), plus limits on challenges, reports, searches, room/group/DM creation and WebSocket frames. Sending the same message twice within 30 seconds is rejected.
- Login returns the same error for an unknown username and a wrong password, and runs a bcrypt comparison in both cases so the timing matches too.
- Logs contain method, path, status and timing only. Bodies, cookies and query strings are never logged, and a test checks that no password or token reaches the logs.

Rate-limit counters live in memory, so they reset when the server restarts. That's fine for a single instance. If you ever run several instances, move them to a shared store.

## Deploying

The app is one process with a SQLite file, so **it needs a persistent disk**. Without one, every redeploy or restart wipes all accounts and messages. Run a single instance, because SQLite and the in-memory presence and rate-limit state assume one process.

### Render

1. Push this folder to a Git repository and create a **Web Service** from it.
2. Build command: `npm install`. Start command: `npm start`.
3. Add a **persistent disk** mounted at `/data` (1 GB is plenty). Render only offers disks on paid instance types. Free web services have an ephemeral filesystem and also spin down when idle, so for an always-on community the smallest paid plan is the realistic minimum.
4. Environment variables: `DB_PATH=/data/chat.db`, `TRUST_PROXY=1`, and optionally `INVITE_CODE` and `SESSION_DAYS`.
5. Render gives you HTTPS automatically, so cookies get the `Secure` flag.

### Fly.io

```bash
fly launch --no-deploy            # creates fly.toml; choose a region near your users
fly volumes create chat_data --size 1
```

Then add this to `fly.toml`:

```toml
[env]
  DB_PATH = "/data/chat.db"
  TRUST_PROXY = "1"

[mounts]
  source = "chat_data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"   # keep the chat online and WebSockets connected
  min_machines_running = 1
```

```bash
fly secrets set INVITE_CODE=your-code   # optional
fly deploy
```

Keep it to **one machine** (`fly scale count 1`), because a volume can only be attached to one machine at a time.

### Backups

SQLite makes backups easy. Pick at least one of these:

- **Snapshot with the SQLite CLI.** This is safe while the app is running:
  ```bash
  sqlite3 /data/chat.db ".backup '/data/backup-$(date +%F).db'"
  ```
  Run it daily from a cron job or a scheduled task, then copy the file somewhere other than the server (object storage or another machine). Keep a week or two of copies.
- **Continuous replication** with [Litestream](https://litestream.io), which streams changes to S3-compatible storage and can restore to any point in time.
- **Host snapshots.** Fly volumes take daily snapshots automatically, and Render disks have snapshots too. They're convenient but stay inside the same provider, so treat them as a second line of defence.

Test a restore at least once. Copy a backup to `DB_PATH` on a scratch instance and start the app.

### Production checklist

- HTTPS in front of the app. Both hosts above handle this.
- `TRUST_PROXY=1` when behind the host's proxy. Leave it unset if the app is exposed directly, or clients could fake their IP to dodge rate limits.
- Persistent disk mounted, with `DB_PATH` pointing at it.
- Sign up the admin account **right after the first deploy**, because the first account becomes admin. Or set `INVITE_CODE` before going live.
- Seed the word filter from `/admin`.
- Back up on a schedule.

## Project layout

```
server.js         HTTP API, WebSocket server, auth, moderation
db.js             SQLite schema (created on first run) and seed rooms
lib/filter.js     Word filter normalisation and matching
lib/ratelimit.js  Sliding-window rate limiter
public/           index.html, app.js, admin.html, admin.js, common.js, CSS
test/             End-to-end test suite (node:test)
```
