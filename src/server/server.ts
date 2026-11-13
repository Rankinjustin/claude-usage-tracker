import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type FSWatcher, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/log';
import { dbPath as defaultDbPath, ensureDataHome, projectsRoot, stateFile } from '../core/paths';
import type { Range } from '../core/types';
import { indexAllAsync } from '../ingest/indexer';
import { withWriteLockAsync } from '../ingest/lock';
import {
  agentDetail, agents, coverage, overview, promptDetail, prompts, sessionDetail, sessions,
} from '../query/views';
import { openDb } from '../store/db';

export interface ServerOptions {
  port?: number;
  /** Shut down after this long with no requests and no SSE clients (default 30 min). */
  idleMs?: number;
  /** Transcripts root to index and watch (default: the real one). */
  root?: string;
  dbPath?: string;
  /** Directory holding the built UI (default: `ui/` next to the server bundle). */
  uiDir?: string;
  /** Quiet period before a burst of file changes is indexed (default 500 ms). */
  debounceMs?: number;
  /** Called after the server has shut down by itself (idle) or via a signal. */
  onClosed?: () => void;
}

export interface RunningServer { url: string; port: number; key: string; close(): Promise<void> }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
const PRESETS = ['today', 'week', 'month', 'all'];
const HEARTBEAT_MS = 25_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Parses `range=today|week|month|all` or `range=<from>,<to>`; throws a 400 for anything else. */
function parseRange(param: string | null): Range {
  const v = param ?? 'week';
  if (PRESETS.includes(v)) return { preset: v as 'today' | 'week' | 'month' | 'all' };
  const parts = v.split(',');
  const ok = (s: string): boolean => /^\d{4}-\d\d-\d\d/.test(s) && !Number.isNaN(Date.parse(s));
  if (parts.length === 2 && ok(parts[0]!) && ok(parts[1]!)) return { from: parts[0]!, to: parts[1]! };
  throw new HttpError(400, 'invalid range');
}

function sameKey(given: string | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieKey(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'tt_key') return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Starts the loopback server: static UI, read-only JSON API, SSE, indexing and idle shutdown. */
export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  ensureDataHome();
  const root = resolve(opts.root ?? projectsRoot());
  const uiDir = resolve(opts.uiDir ?? fileURLToPath(new URL('./ui/', import.meta.url)));
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;
  const debounceMs = opts.debounceMs ?? 500;
  const key = randomBytes(32).toString('hex');
  const db = openDb(opts.dbPath ?? defaultDbPath());
  const clients = new Set<ServerResponse>();
  let lastActivity = Date.now();
  let port = 0;
  let closed = false;

  let current: Promise<unknown> | undefined;
  let debounce: NodeJS.Timeout | undefined;
  /** Coalesces change bursts and lock-busy retries into one pending pass. */
  const schedule = (): void => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { void runIndex(); }, debounceMs);
  };

  /**
   * Indexes under the write lock without blocking the event loop and tells SSE clients which sessions
   * changed. When another process holds the lock (e.g. the first-run backfill) it retries later.
   */
  async function runIndex(): Promise<{ indexed: boolean; changed: string[]; queued: boolean }> {
    const none = { indexed: false, changed: [] as string[], queued: false };
    if (closed) return none;
    if (current) await current;
    if (closed) return none;
    const pass = withWriteLockAsync(() => indexAllAsync(db, { root }));
    current = pass;
    try {
      const r = await pass;
      if (r === 'busy') { schedule(); return { ...none, queued: true }; }
      if (r.failed) log(`server index: ${r.failed} file(s) failed: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      if (r.changedSessions.length) {
        const msg = `data: ${JSON.stringify({ changed: r.changedSessions })}

`;
        for (const c of clients) c.write(msg);
      }
      return { indexed: true, changed: r.changedSessions, queued: false };
    } catch (e) {
      log(`server index failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return none;
    } finally {
      if (current === pass) current = undefined;
    }
  }

  let watcher: FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;
  const startPolling = (): void => {
    watcher?.close();
    watcher = undefined;
    poll ??= setInterval(schedule, 2000);
  };
  try {
    // libuv aborts the process on Windows when given an 8.3 short path, so watch the real long path.
    watcher = watch(realpathSync.native(root), { recursive: true }, (_ev, name) => {
      if (!name || String(name).endsWith('.jsonl')) schedule();
    });
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }

  function api(path: string, q: URLSearchParams): unknown {
    let seg: string[];
    try { seg = path.split('/').slice(2).map(decodeURIComponent); } catch { throw new HttpError(400, 'bad path'); }
    const [name, arg] = seg;
    if (seg.length > 2 || !name) throw new HttpError(404, 'not found');
    const found = <T>(v: T | null | undefined): T => {
      if (v == null) throw new HttpError(404, 'not found');
      return v;
    };
    const sessionOr404 = (id: string): unknown => {
      const d = sessionDetail(db, id);
      if (!d.session) throw new HttpError(404, 'not found');
      return d;
    };
    const range = (): Range => parseRange(q.get('range'));
    switch (name) {
      case 'overview': return overview(db, range());
      case 'sessions': return arg ? sessionOr404(arg) : sessions(db, range());
      case 'prompts': return arg ? found(promptDetail(db, arg)) : prompts(db, range(), q.get('q') ?? undefined);
      case 'agents': return arg ? agentDetail(db, arg, range()) : agents(db, range());
      case 'coverage': return coverage(db);
      default: throw new HttpError(404, 'not found');
    }
  }

  function send(res: ServerResponse, status: number, body: string | Buffer, type: string,
    extra: Record<string, string> = {}): void {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP, ...extra,
    });
    res.end(body);
  }
  const sendJson = (res: ServerResponse, status: number, v: unknown): void =>
    send(res, status, JSON.stringify(v), 'application/json; charset=utf-8');

  function serveStatic(res: ServerResponse, pathname: string, extra: Record<string, string>): void {
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad path'); }
    if (rel.includes('\0')) throw new HttpError(400, 'bad path');
    let file = resolve(uiDir, '.' + (rel.startsWith('/') ? rel : '/' + rel));
    if (file !== uiDir && !file.startsWith(uiDir + sep)) throw new HttpError(403, 'forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) file = resolve(uiDir, 'index.html');
    if (!existsSync(file)) throw new HttpError(404, 'ui not built');
    send(res, 200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', extra);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    lastActivity = Date.now();
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'bad host');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      throw new HttpError(403, 'bad origin');
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const queryKey = req.method === 'GET' && url.pathname === '/' ? (url.searchParams.get('key') ?? undefined) : undefined;
    const viaQuery = sameKey(queryKey, key);
    if (!viaQuery && !sameKey(bearer, key) && !sameKey(cookieKey(req.headers.cookie), key)) {
      throw new HttpError(401, 'unauthorized');
    }
    const cookie: Record<string, string> = viaQuery ? { 'Set-Cookie': `tt_key=${key}; HttpOnly; SameSite=Strict; Path=/` } : {};

    if (url.pathname === '/api/poke') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      void runIndex().then(
        (r) => r.queued
          ? sendJson(res, 202, { ok: true, indexed: false, queued: true })
          : sendJson(res, 200, { ok: true, indexed: r.indexed, changed: r.changed }),
        () => sendJson(res, 500, { error: 'internal error' }),
      );
      return;
    }
    if (url.pathname === '/api/events') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      res.on('close', () => { clearInterval(beat); clients.delete(res); lastActivity = Date.now(); });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      return sendJson(res, 200, api(url.pathname, url.searchParams));
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    serveStatic(res, url.pathname, cookie);
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) { sendJson(res, e.status, { error: e.message }); return; }
      sendJson(res, 500, { error: 'internal error' });
    }
  });

  const serverFile = stateFile('server.json');
  /** Removes server.json only while it still names this server, never another one's. */
  const removeServerFile = (): void => {
    try {
      const cur = JSON.parse(readFileSync(serverFile, 'utf8')) as { pid?: number; key?: string };
      if (cur.pid === process.pid && cur.key === key) rmSync(serverFile, { force: true });
    } catch { /* already gone */ }
  };
  const onExit = (): void => removeServerFile();
  const onSignal = (): void => { void close().then(() => { opts.onClosed?.(); process.exit(0); }); };

  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((done) => {
      closed = true;
      clearTimeout(debounce);
      clearInterval(idleTimer);
      if (poll) clearInterval(poll);
      watcher?.close();
      process.off('exit', onExit);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      removeServerFile();
      for (const c of clients) c.end();
      clients.clear();
      server.close(() => {
        void Promise.resolve(current).catch(() => undefined).then(() => {
          try { db.close(); } catch { /* already closed */ }
          done();
        });
      });
      server.closeAllConnections();
    });
    return closing;
  }

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => ok());
  });
  port = (server.address() as { port: number }).port;
  const tmpFile = `${serverFile}.tmp`;
  writeFileSync(tmpFile, JSON.stringify({ pid: process.pid, port, key, startedAt: new Date().toISOString() }),
    { mode: 0o600 });
  renameSync(tmpFile, serverFile);
  server.on('error', (e) => log(`server error: ${e instanceof Error ? e.message : String(e)}`));
  process.on('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  idleTimer = setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActivity >= idleMs) void close().then(() => opts.onClosed?.());
  }, Math.max(20, Math.min(1000, idleMs / 4)));
  idleTimer.unref();

  setTimeout(() => { void runIndex(); }, 0);

  return { url: `http://127.0.0.1:${port}/?key=${key}`, port, key, close };
}
