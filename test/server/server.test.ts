import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { withWriteLockAsync } from '../../src/ingest/lock';
import { startServer, type RunningServer } from '../../src/server/server';

let home: string;
let root: string;
let srv: RunningServer | undefined;
const savedHome = process.env.TOKEN_TRACKER_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tt-srv-home-'));
  root = mkdtempSync(join(tmpdir(), 'tt-srv-root-'));
  process.env.TOKEN_TRACKER_HOME = home;
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  if (savedHome === undefined) delete process.env.TOKEN_TRACKER_HOME;
  else process.env.TOKEN_TRACKER_HOME = savedHome;
});

const start = async (o: { idleMs?: number } = {}) => {
  srv = await startServer({ port: 0, root, dbPath: join(home, 'test.db'), uiDir: 'dist/ui', debounceMs: 50, ...o });
  return srv;
};
const u = (s: RunningServer, p: string) => `http://127.0.0.1:${s.port}${p}`;
const auth = (s: RunningServer) => ({ Authorization: `Bearer ${s.key}` });

/** fetch cannot override Host or Origin, so these tests use node:http. */
function raw(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((done, fail) => {
    const r = request({ host: '127.0.0.1', port, path, headers }, (res) => { res.resume(); done(res.statusCode ?? 0); });
    r.on('error', fail);
    r.end();
  });
}

test('rejects request without key (401)', async () => {
  const s = await start();
  expect((await fetch(u(s, '/api/overview'))).status).toBe(401);
  expect((await fetch(u(s, '/'))).status).toBe(401);
  expect((await fetch(u(s, '/api/overview'), { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  expect((await fetch(u(s, '/api/overview'), { headers: auth(s) })).status).toBe(200);
});

test('accepts cookie after keyed load', async () => {
  const s = await start();
  const first = await fetch(s.url);
  expect(first.status).toBe(200);
  const setCookie = first.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain(`tt_key=${s.key}`);
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  expect(first.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(first.headers.get('x-content-type-options')).toBe('nosniff');
  expect(first.headers.get('access-control-allow-origin')).toBeNull();
  const next = await fetch(u(s, '/api/coverage'), { headers: { Cookie: `tt_key=${s.key}` } });
  expect(next.status).toBe(200);
  expect((await fetch(u(s, '/api/coverage?key=' + s.key))).status).toBe(401); // query key is for GET / only
});

test('rejects foreign Host header (403)', async () => {
  const s = await start();
  expect(await raw(s.port, '/api/overview', { ...auth(s), Host: 'evil.example' })).toBe(403);
  expect(await raw(s.port, '/api/overview', { ...auth(s), Host: `evil.example:${s.port}` })).toBe(403);
  expect(await raw(s.port, '/api/overview', { ...auth(s), Host: `localhost:${s.port}` })).toBe(200);
});

test('rejects a foreign Origin (403)', async () => {
  const s = await start();
  expect(await raw(s.port, '/api/overview', { ...auth(s), Origin: 'https://evil.example' })).toBe(403);
  expect(await raw(s.port, '/api/overview', { ...auth(s), Origin: `http://127.0.0.1:${s.port}` })).toBe(200);
});

test('listens on 127.0.0.1 only', async () => {
  const s = await start();
  const info = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
  expect(info.port).toBe(s.port);
  expect(info.key).toBe(s.key);
  expect(info.pid).toBe(process.pid);
  expect(s.url).toBe(`http://127.0.0.1:${s.port}/?key=${s.key}`);
  // A non-loopback address of this machine must refuse the connection.
  const { networkInterfaces } = await import('node:os');
  const other = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (other) await expect(fetch(`http://${other}:${s.port}/api/overview`, { headers: auth(s) })).rejects.toThrow();
});

test('invalid range is a 400 JSON error', async () => {
  const s = await start();
  for (const bad of ['yesterday', 'a,b', '2026-01-01', '2026-01-01,nope']) {
    const res = await fetch(u(s, '/api/sessions?range=' + encodeURIComponent(bad)), { headers: auth(s) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  }
  const ok = await fetch(u(s, '/api/sessions?range=2026-01-01,2026-02-01'), { headers: auth(s) });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual([]);
});

test('path traversal cannot escape the ui directory', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/..%5c..%5cpackage.json',
    '/assets/..%2f..%2f..%2fpackage.json']) {
    const s = srv ?? (await start());
    expect(await raw(s.port, p, auth(s)), p).toBe(403);
  }
});

test('unknown API paths are 404 and unknown ids are 404', async () => {
  const s = await start();
  expect((await fetch(u(s, '/api/nope'), { headers: auth(s) })).status).toBe(404);
  expect((await fetch(u(s, '/api/sessions/missing'), { headers: auth(s) })).status).toBe(404);
  expect((await fetch(u(s, '/api/prompts/missing'), { headers: auth(s) })).status).toBe(404);
});

test('poke triggers index and SSE change event', async () => {
  const s = await start();
  const res = await fetch(u(s, '/api/events'), { headers: auth(s) });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      seen += dec.decode(value);
      if (seen.includes('"changed"')) return;
    }
  })();
  mkdirSync(join(root, 'proj'));
  copyFileSync('test/fixtures/agent.jsonl', join(root, 'proj', 'sess.jsonl'));
  const poke = await fetch(u(s, '/api/poke'), { method: 'POST', headers: auth(s) });
  expect(poke.status).toBe(200);
  await Promise.race([pump, new Promise((_, no) => setTimeout(() => no(new Error('no SSE event: ' + seen)), 5000))]);
  const line = /data: (\{.*\})/.exec(seen)![1]!;
  expect(JSON.parse(line).changed.length).toBeGreaterThan(0);
  await reader.cancel();
  const list = await (await fetch(u(s, '/api/sessions?range=all'), { headers: auth(s) })).json();
  expect(list.length).toBeGreaterThan(0);
  expect((await fetch(u(s, '/api/poke'), { headers: auth(s) })).status).toBe(405);
});

test('shuts down after idle with no clients', async () => {
  let closedCb = false;
  srv = await startServer({
    port: 0, idleMs: 200, root, dbPath: join(home, 'test.db'), uiDir: 'dist/ui', onClosed: () => { closedCb = true; },
  });
  const s = srv;
  await new Promise((r) => setTimeout(r, 1200));
  await expect(fetch(u(s, '/api/overview'), { headers: auth(s) })).rejects.toThrow();
  expect(existsSync(join(home, 'server.json'))).toBe(false);
  expect(closedCb).toBe(true);
});

test('an open SSE client keeps the server alive', async () => {
  const s = await start({ idleMs: 200 });
  const res = await fetch(u(s, '/api/events'), { headers: auth(s) });
  await new Promise((r) => setTimeout(r, 900));
  expect((await fetch(u(s, '/api/overview'), { headers: auth(s) })).status).toBe(200);
  await res.body!.cancel();
});

test('server.json removed on close', async () => {
  const s = await start();
  expect(existsSync(join(home, 'server.json'))).toBe(true);
  await s.close();
  expect(existsSync(join(home, 'server.json'))).toBe(false);
});

test('server answers requests while another process holds the lock', async () => {
  const s = await start();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held = withWriteLockAsync(() => gate);
  mkdirSync(join(root, 'proj'));
  copyFileSync('test/fixtures/agent.jsonl', join(root, 'proj', 'sess.jsonl'));
  await new Promise((r) => setTimeout(r, 400)); // watcher fires and finds the lock busy
  const t0 = Date.now();
  expect((await fetch(u(s, '/api/coverage'), { headers: auth(s) })).status).toBe(200);
  expect(Date.now() - t0).toBeLessThan(300);
  const poke = await fetch(u(s, '/api/poke'), { method: 'POST', headers: auth(s) });
  expect(poke.status).toBe(202);
  expect(await poke.json()).toMatchObject({ indexed: false, queued: true });
  release();
  await held;
  const deadline = Date.now() + 5000;
  let n = 0;
  while (n === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    n = (await (await fetch(u(s, '/api/sessions?range=all'), { headers: auth(s) })).json()).length;
  }
  expect(n).toBeGreaterThan(0);
});
