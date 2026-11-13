import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
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

function isStale(path: string): boolean {
  try {
    const { pid, ts } = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; ts: number };
    return !pidAlive(pid) || !(Date.now() - ts < STALE_MS);
  } catch {
    // Unreadable or half-written: the creator may be mid-write, so treat it as held.
    return false;
  }
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
      if (!isStale(path)) return false;
      try { unlinkSync(path); } catch { /* another process took it over first */ }
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
