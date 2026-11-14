import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startServer, type RunningServer } from '../src/server/server';

let home: string;
let srv: RunningServer | undefined;
const saved = process.env.TOKEN_TRACKER_HOME;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tt-open-')); process.env.TOKEN_TRACKER_HOME = home; });
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  const f = join(home, 'server.json');
  if (existsSync(f)) {
    try { process.kill(JSON.parse(readFileSync(f, 'utf8')).pid); } catch { /* already gone */ }
  }
  if (saved === undefined) delete process.env.TOKEN_TRACKER_HOME;
  else process.env.TOKEN_TRACKER_HOME = saved;
});

/** Async so an in-process server in this test can still answer the child. */
function runOpen(env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const c: ChildProcess = spawn(process.execPath, ['dist/cli.mjs', 'open'], {
      env: {
        ...process.env, TOKEN_TRACKER_HOME: home, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'tt-claude-')),
        TOKEN_TRACKER_NO_BROWSER: '1', TOKEN_TRACKER_NO_SPAWN: '1', ...env,
      },
    });
    let stdout = '';
    c.stdout!.on('data', (d) => { stdout += d; });
    c.on('close', (code) => done({ code, stdout }));
  });
}

const liveServer = () => startServer({
  port: 0, root: mkdtempSync(join(tmpdir(), 'tt-root-')), dbPath: join(home, 'test.db'), uiDir: 'dist/ui',
});

test('reuses live server', async () => {
  srv = await liveServer();
  const before = readFileSync(join(home, 'server.json'), 'utf8');
  const r = await runOpen();
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`Token Tracker: http://127.0.0.1:${srv.port}/?key=${srv.key}\n`);
  expect(readFileSync(join(home, 'server.json'), 'utf8')).toBe(before);
  expect(readFileSync(join(home, 'debug.log'), 'utf8')).toContain('browser open skipped: http://127.0.0.1');
});

test('open is a first-run entry point: writes installed.json and starts the backfill', async () => {
  srv = await liveServer();
  expect(existsSync(join(home, 'installed.json'))).toBe(false);
  const r = await runOpen();
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(join(home, 'installed.json'), 'utf8')).installedAt).toBeTruthy();
  const spawns = (): number => (readFileSync(join(home, 'debug.log'), 'utf8').match(/backfill spawn skipped/g) ?? []).length;
  expect(spawns()).toBe(1);
  // Second open: the marker exists, so only an abandoned backfill would spawn again. Record a finished one
  // in the default store and expect no further spawn.
  const { openDb } = await import('../src/store/db');
  const db = openDb(join(home, 'tracker.db'));
  db.meta.set('backfill_progress', JSON.stringify({ done: 1, total: 1, startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString() }));
  db.close();
  await runOpen();
  expect(spawns()).toBe(1);
});

test('starts server when server.json is stale', async () => {
  writeFileSync(join(home, 'server.json'), JSON.stringify({
    pid: 2147483000, port: 1, key: 'old', startedAt: '2020-01-01T00:00:00.000Z',
  }));
  const r = await runOpen();
  expect(r.code).toBe(0);
  const info = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
  expect(info.key).not.toBe('old');
  expect(r.stdout).toBe(`Token Tracker: http://127.0.0.1:${info.port}/?key=${info.key}\n`);
  const res = await fetch(`http://127.0.0.1:${info.port}/api/coverage`, { headers: { Authorization: `Bearer ${info.key}` } });
  expect(res.status).toBe(200);
}, 20000);

test('prints url even if browser open fails', async () => {
  srv = await liveServer();
  // Empty PATH/ComSpec makes the opener fail to launch; the URL must still print and exit stay 0.
  const r = await runOpen({ TOKEN_TRACKER_NO_BROWSER: '', PATH: '', Path: '', ComSpec: '' });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`Token Tracker: http://127.0.0.1:${srv.port}/?key=${srv.key}\n`);
});
