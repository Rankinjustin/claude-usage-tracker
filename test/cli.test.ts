import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

function runCli(sub: string, opts: { input?: string; home?: string; env?: Record<string, string> } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'tt-cli-'));
  const claude = mkdtempSync(join(tmpdir(), 'tt-claude-'));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['dist/cli.mjs', sub], {
    input: opts.input ?? '',
    encoding: 'utf8',
    env: {
      ...process.env, TOKEN_TRACKER_HOME: home, CLAUDE_CONFIG_DIR: claude,
      TOKEN_TRACKER_NO_SPAWN: '1', ...opts.env,
    },
  });
  return { home, r, ms: Date.now() - t0 };
}

test('hook-start first run writes installed.json and returns fast', () => {
  const { home, r, ms } = runCli('hook-start', { input: '{"session_id":"s"}' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(JSON.parse(readFileSync(join(home, 'installed.json'), 'utf8')).installedAt).toBeTruthy();
  expect(readFileSync(join(home, 'debug.log'), 'utf8')).toContain('spawn skipped');
  expect(ms).toBeLessThan(2000); // generous for CI; node startup alone is ~50 ms
});

test('hook-start second run leaves installed.json alone', () => {
  const first = runCli('hook-start');
  const before = readFileSync(join(first.home, 'installed.json'), 'utf8');
  const second = runCli('hook-start', { home: first.home });
  expect(second.r.status).toBe(0);
  expect(readFileSync(join(first.home, 'installed.json'), 'utf8')).toBe(before);
});

test('hook-end never exits non-zero on bad stdin', () => {
  const { home, r } = runCli('hook-end', { input: '{not json' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(readFileSync(join(home, 'debug.log'), 'utf8')).toContain('bad hook stdin');
  expect(existsSync(join(home, 'tracker.db'))).toBe(true);
});

test('index and backfill print a one-line summary', () => {
  const idx = runCli('index');
  expect(idx.r.status).toBe(0);
  expect(idx.r.stdout).toMatch(/^indexed 0 files/);
  const bf = runCli('backfill', { home: idx.home });
  expect(bf.r.status).toBe(0);
  expect(bf.r.stdout).toMatch(/^indexed 0 files/);
});

test('old node version prints message and exits 0', () => {
  const { r, home } = runCli('hook-start', { env: { TOKEN_TRACKER_FAKE_NODE_VERSION: '20.11.1' } });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr.trim()).toBe('Token Tracker needs Node 22.13 or newer (found 20.11.1).');
  expect(existsSync(join(home, 'installed.json'))).toBe(false);
});

const spawns = (home: string): number =>
  (readFileSync(join(home, 'debug.log'), 'utf8').match(/spawn skipped/g) ?? []).length;

test('hook-start retries a backfill that never finished', () => {
  const first = runCli('hook-start');
  expect(spawns(first.home)).toBe(1);
  // No backfill_progress yet: the earlier backfill died, so the next session retries it.
  const second = runCli('hook-start', { home: first.home });
  expect(second.r.status).toBe(0);
  expect(spawns(first.home)).toBe(2);
  // A finished backfill is not rerun.
  expect(runCli('backfill', { home: first.home }).r.status).toBe(0);
  runCli('hook-start', { home: first.home });
  expect(spawns(first.home)).toBe(2);
});

test('hook-end with a dead server pid indexes under the lock', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-cli-'));
  writeFileSync(join(home, 'server.json'), JSON.stringify({ pid: 2 ** 22 + 12345, port: 9, key: 'k' }));
  const { r } = runCli('hook-end', { home });
  expect(r.status).toBe(0);
  expect(existsSync(join(home, 'tracker.db'))).toBe(true);
  expect(existsSync(join(home, 'write.lock'))).toBe(false);
});

test('hook-end skips and exits 0 when another indexer holds the lock', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-cli-'));
  writeFileSync(join(home, 'write.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const { r } = runCli('hook-end', { home });
  expect(r.status).toBe(0);
  expect(readFileSync(join(home, 'debug.log'), 'utf8')).toContain('skipped');
  expect(existsSync(join(home, 'write.lock'))).toBe(true);
});
