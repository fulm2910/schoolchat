'use strict';

/**
 * In-memory sliding-window rate limiter. Fine for a single-process app;
 * state resets on restart, which is acceptable for abuse throttling.
 */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> array of timestamps (ascending)
    this.sweeper = setInterval(() => this.sweep(), Math.max(windowMs, 60_000));
    this.sweeper.unref();
  }

  recent(key, now) {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    while (list.length && list[0] <= cutoff) list.shift();
    if (!list.length) this.hits.delete(key);
    return list;
  }

  /** Is the key currently allowed, without recording anything? */
  check(key, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length < this.max) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: list[0] + this.windowMs - now };
  }

  /** Record one hit and report whether it was within the limit. */
  hit(key, now = Date.now()) {
    const result = this.check(key, now);
    if (!result.ok) return result;
    let list = this.hits.get(key);
    if (!list) this.hits.set(key, (list = []));
    list.push(now);
    return result;
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep(now = Date.now()) {
    for (const key of this.hits.keys()) this.recent(key, now);
  }
}

module.exports = { RateLimiter };
