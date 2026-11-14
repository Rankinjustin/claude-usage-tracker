import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { isSafeDashboardUrl } from '../src/core/safeUrl';
import { formatStatusLine } from '../src/statusline';
import { openDb } from '../src/store/db';

function runCli(args: string[], opts: { input?: string; home?: string; claude?: string } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'tt-sl-'));
  const claude = opts.claude ?? mkdtempSync(join(tmpdir(), 'tt-slc-'));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['dist/cli.mjs', ...args], {
    input: opts.input ?? '', encoding: 'utf8',
    env: { ...process.env, TOKEN_TRACKER_HOME: home, CLAUDE_CONFIG_DIR: claude, TOKEN_TRACKER_NO_SPAWN: '1' },
  });
  return { home, claude, r, ms: Date.now() - t0 };
}

function seed(home: string, rows: { id: string; session: string; ts: string; cost: number }[], bulk = 0) {
  const db = openDb(join(home, 'tracker.db'));
  const ins = db.raw.prepare(`INSERT INTO api_calls (message_id, session_id, run_id, ts, model, speed, input,
    cache_write_5m, cache_write_1h, cache_read, output, thinking, ctx_tokens, cost)
    VALUES (?, ?, 'r', ?, 'claude-opus-4-5', 'standard', 1, 0, 0, 0, 1, 0, 1000, ?)`);
  db.raw.exec('BEGIN');
  for (const r of rows) ins.run(r.id, r.session, r.ts, r.cost);
  for (let i = 0; i < bulk; i++) {
    ins.run(`bulk-${i}`, `s${i % 400}`, new Date(Date.now() - i * 60000).toISOString(), 0.01);
  }
  db.raw.exec('COMMIT');
  db.close();
}

const stdin = (o: object) => JSON.stringify(o);
const nowIso = () => new Date().toISOString();

test('formats today, session, context', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-sl-'));
  seed(home, [
    { id: 'a', session: 'S1', ts: nowIso(), cost: 4 },
    { id: 'b', session: 'S1', ts: nowIso(), cost: 7.03 },
    { id: 'c', session: 'S2', ts: nowIso(), cost: 1 },
  ]);
  const { r } = runCli(['statusline'], { home, input: stdin({
    session_id: 'S1', cost: { total_cost_usd: 99 },
    context_window: { used_percentage: 14.7, context_window_size: 1000000 },
  }) });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('▮▮▮ $12.03 today · session $11.03 · context 147K\n');
});

test('shows alert marker', () => {
  const base = { today: 3, session: 1, contextTokens: null };
  expect(formatStatusLine({ ...base, alerts: 1 })).toBe('▮▮▮ $3.00 today · session $1.00 · ▲ 1 alert');
  expect(formatStatusLine({ ...base, alerts: 3, contextTokens: 147000 }))
    .toBe('▮▮▮ $3.00 today · session $1.00 · context 147K · ▲ 3 alerts');
  expect(formatStatusLine({ ...base, alerts: 0 })).not.toContain('▲');
  expect(formatStatusLine({ today: 0.004, session: 0, alerts: 0, contextTokens: null }))
    .toBe('▮▮▮ $0.00 today · session $0.00');
});

test('falls back to stdin cost when db missing', () => {
  const { r, home } = runCli(['statusline'], { input: stdin({
    session_id: 'S1', cost: { total_cost_usd: 2.5 },
    context_window: { used_percentage: 10, context_window_size: 200000 },
  }) });
  expect(r.stdout).toBe('▮▮▮ today — · session $2.50 · context 20K\n');
  expect(existsSync(join(home, 'tracker.db'))).toBe(false);
});

test('empty or invalid stdin still prints one line', () => {
  const empty = runCli(['statusline'], { input: '' });
  expect(empty.r.stdout).toBe('▮▮▮ Token Tracker\n');
  const home = mkdtempSync(join(tmpdir(), 'tt-sl-'));
  seed(home, [{ id: 'a', session: 'S1', ts: nowIso(), cost: 3 }]);
  const bad = runCli(['statusline'], { home, input: '{nope' });
  expect(bad.r.stdout).toBe('▮▮▮ $3.00 today\n');
});

test('writes nothing on the happy path', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-sl-'));
  seed(home, [{ id: 'a', session: 'S1', ts: nowIso(), cost: 1 }]);
  runCli(['statusline'], { home, input: stdin({ session_id: 'S1' }) });
  expect(existsSync(join(home, 'debug.log'))).toBe(false);
});

test('statusline stays fast on 20k calls', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-sl-'));
  seed(home, [], 20000);
  const { r, ms } = runCli(['statusline'], { home, input: stdin({ session_id: 's1' }) });
  console.log(`statusline on 20k calls: ${ms} ms`);
  expect(r.stdout).toMatch(/^▮▮▮ \$\d+\.\d\d today · session \$/);
  expect(ms).toBeLessThan(500);
});

const settingsOf = (claude: string) => join(claude, 'settings.json');

test('setup --check reports state', () => {
  const claude = mkdtempSync(join(tmpdir(), 'tt-slc-'));
  expect(runCli(['setup', '--check'], { claude }).r.stdout).toBe('Status line: not set\n');
  writeFileSync(settingsOf(claude), JSON.stringify({ statusLine: { type: 'command', command: 'foo bar' } }));
  expect(runCli(['setup', '--check'], { claude }).r.stdout).toBe('Status line: other (foo bar)\n');
  runCli(['setup', '--apply', '--replace'], { claude });
  expect(runCli(['setup', '--check'], { claude }).r.stdout).toBe('Status line: Token Tracker\n');
});

test('setup refuses to overwrite existing statusLine without --replace', () => {
  const claude = mkdtempSync(join(tmpdir(), 'tt-slc-'));
  const original = JSON.stringify({ statusLine: { type: 'command', command: 'mine' } });
  writeFileSync(settingsOf(claude), original);
  const { r } = runCli(['setup', '--apply'], { claude });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('--replace');
  expect(readFileSync(settingsOf(claude), 'utf8')).toBe(original);
});

test('setup writes backup', () => {
  const claude = mkdtempSync(join(tmpdir(), 'tt-slc-'));
  const original = JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'mine' } });
  writeFileSync(settingsOf(claude), original);
  runCli(['setup', '--apply', '--replace'], { claude });
  expect(readFileSync(join(claude, 'settings.json.bak-token-tracker'), 'utf8')).toBe(original);
  const now = JSON.parse(readFileSync(settingsOf(claude), 'utf8'));
  expect(now.theme).toBe('dark');
  expect(now.statusLine.type).toBe('command');
  expect(now.statusLine.command).toMatch(/^node ".*cli\.mjs" statusline$/);
});

test('setup creates settings when missing and is idempotent', () => {
  const claude = join(mkdtempSync(join(tmpdir(), 'tt-slc-')), 'nested');
  mkdirSync(claude);
  const a = runCli(['setup', '--apply'], { claude });
  expect(a.r.stdout).toContain('installed');
  expect(JSON.parse(readFileSync(settingsOf(claude), 'utf8')).statusLine.type).toBe('command');
  const b = runCli(['setup', '--apply'], { claude });
  expect(b.r.stdout).toContain('already');
});

test('browser url guard', () => {
  expect(isSafeDashboardUrl('http://127.0.0.1:5123/?key=abc123')).toBe(true);
  expect(isSafeDashboardUrl('http://127.0.0.1:5123/?key=abc&calc=1')).toBe(false);
  expect(isSafeDashboardUrl('http://evil.com/?key=ab')).toBe(false);
  expect(isSafeDashboardUrl('http://127.0.0.1:1/?key=ab" & calc')).toBe(false);
});
