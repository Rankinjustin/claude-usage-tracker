import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { withWriteLock } from '../../src/ingest/lock';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tt-lock-'));
  process.env.TOKEN_TRACKER_HOME = home;
});
afterEach(() => { delete process.env.TOKEN_TRACKER_HOME; });

test('second indexer skips while lock held', () => {
  let inner: string | undefined;
  const outer = withWriteLock(() => {
    inner = withWriteLock(() => 'ran');
    return 'outer';
  });
  expect(outer).toBe('outer');
  expect(inner).toBe('busy');
  expect(existsSync(join(home, 'write.lock'))).toBe(false);
  expect(withWriteLock(() => 'again')).toBe('again');
});

test('stale lock from dead pid is taken over', () => {
  writeFileSync(join(home, 'write.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, ts: Date.now() }));
  expect(withWriteLock(() => 'ok')).toBe('ok');
});

test('lock older than ten minutes is taken over even if pid is alive', () => {
  writeFileSync(join(home, 'write.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() - 11 * 60_000 }));
  expect(withWriteLock(() => 'ok')).toBe('ok');
});

test('lock is released when fn throws', () => {
  expect(() => withWriteLock(() => { throw new Error('boom'); })).toThrow('boom');
  expect(existsSync(join(home, 'write.lock'))).toBe(false);
});
