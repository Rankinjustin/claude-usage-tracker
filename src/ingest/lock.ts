import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataHome, ensureDataHome } from '../core/paths';

const STALE_MS = 10 * 60 * 1000;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** True when a process with this pid exists (EPERM means it exists but is not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Lock files with no readable owner are given this long to finish being written. */
const CORRUPT_GRACE_MS = 30_000;

/** Returns the lock's raw content when it is stale (null when held, or gone). */
function staleContent(path: string): string | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const { pid, ts } = JSON.parse(text) as { pid?: unknown; ts?: unknown };
    if (typeof pid !== 'number') return text;
    return !pidAlive(pid) || typeof ts !== 'number' || !(Date.now() - ts < STALE_MS) ? text : null;
  } catch {
    // Empty or non-JSON: the creator may be mid-write, so only stale once the file is old.
    try { return Date.now() - statSync(path).mtimeMs > CORRUPT_GRACE_MS ? text : null; } catch { return null; }
  }
}

/** Removes the lock only if it still holds the stale content we saw. */
function takeOver(path: string): boolean {
  const seen = staleContent(path);
  if (seen === null) return false;
  try {
    if (readFileSync(path, 'utf8') !== seen) return false;
    unlinkSync(path);
  } catch { /* another process took it over first */ }
  return true;
}

function tryAcquire(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!takeOver(path)) return false;
    }
  }
  return false;
}

/**
 * Runs `fn` as the only writer. Returns 'busy' when a live process holds the lock and `waitMs`
 * (default 0: do not wait) has elapsed. The lock is `<dataHome>/write.lock`.
 */
export function withWriteLock<T>(fn: () => T, opts: { waitMs?: number } = {}): T | 'busy' {
  ensureDataHome();
  const path = join(dataHome(), 'write.lock');
  const deadline = Date.now() + (opts.waitMs ?? 0);
  while (!tryAcquire(path)) {
    if (Date.now() >= deadline) return 'busy';
    sleep(50);
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

/**
 * Async twin of withWriteLock for passes that yield to the event loop while holding the lock.
 * Never blocks the loop: when the lock is held it returns 'busy' immediately.
 */
export async function withWriteLockAsync<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
  ensureDataHome();
  const path = join(dataHome(), 'write.lock');
  if (!tryAcquire(path)) return 'busy';
  try {
    return await fn();
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}
