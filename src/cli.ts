import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dbPath, ensureDataHome, stateFile } from './core/paths';
import { pidAlive, withWriteLock } from './ingest/lock';

const MIN_NODE = [22, 13, 0];

/** True when `version` (e.g. "22.12.0") is older than the minimum supported Node. */
function nodeTooOld(version: string): boolean {
  const v = version.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== MIN_NODE[i]) return (v[i] ?? 0) < MIN_NODE[i];
  }
  return false;
}

function log(message: string): void {
  try {
    ensureDataHome();
    appendFileSync(stateFile('debug.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never fail the session.
  }
}

const errText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** Reads the hook's stdin JSON; never throws and never waits longer than half a second. */
function readStdin(): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done({});
    let text = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed: unknown = text.trim() ? JSON.parse(text) : {};
        done(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch (e) {
        log(`bad hook stdin: ${errText(e)}`);
        done({});
      }
    };
    const timer = setTimeout(() => { process.stdin.pause(); finish(); }, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { text += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function spawnBackfill(): void {
  // Tests set this so they never start a real backfill against the user's transcripts.
  if (process.env.TOKEN_TRACKER_NO_SPAWN) {
    log('hook-start: backfill spawn skipped (TOKEN_TRACKER_NO_SPAWN)');
    return;
  }
  const cli = fileURLToPath(import.meta.url);
  spawn(process.execPath, [cli, 'backfill'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const BACKFILL_STALE_MS = 15 * 60 * 1000;

/** True when an earlier backfill never finished (died) and nobody is writing right now. */
async function backfillAbandoned(): Promise<boolean> {
  const { openDb } = await import('./store/db');
  const r = withWriteLock(() => {
    const db = openDb(dbPath());
    try {
      const raw = db.meta.get('backfill_progress');
      if (!raw) return true;
      const p = JSON.parse(raw) as { startedAt?: string; finishedAt?: string };
      if (p.finishedAt) return false;
      return !(Date.now() - Date.parse(p.startedAt ?? '') < BACKFILL_STALE_MS);
    } finally { db.close(); }
  });
  return r === true;
}

async function hookStart(): Promise<void> {
  ensureDataHome();
  const marker = stateFile('installed.json');
  if (existsSync(marker)) {
    if (await backfillAbandoned()) spawnBackfill();
    return;
  }
  writeFileSync(marker, JSON.stringify({ installedAt: new Date().toISOString() }), { mode: 0o600 });
  spawnBackfill();
}

/** Asks a live server to index; true only when it answered OK. */
async function pokeServer(): Promise<boolean> {
  try {
    const file = stateFile('server.json');
    if (!existsSync(file)) return false;
    const { pid, port, key } = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; port: number; key: string };
    if (!pidAlive(pid)) return false;
    const res = await fetch(`http://127.0.0.1:${port}/api/poke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch (e) {
    log(`poke failed: ${errText(e)}`);
    return false;
  }
}

type Indexer = typeof import('./ingest/indexer');

/**
 * Opens the store and runs `fn` under the write lock. The db and indexer modules load lazily so an
 * old Node never reaches them. Returns false when another process held the lock.
 */
async function indexLocked(fn: (db: import('./store/db').Db, idx: Indexer) => void, waitMs: number): Promise<boolean> {
  const { openDb } = await import('./store/db');
  const idx = await import('./ingest/indexer');
  const r = withWriteLock(() => {
    const db = openDb(dbPath());
    try { fn(db, idx); } finally { db.close(); }
  }, { waitMs });
  return r !== 'busy';
}

const summary = (r: import('./ingest/indexer').IndexResult): string =>
  `indexed ${r.files} files, ${r.newCalls} new calls, ${r.newPrompts} new prompts` +
  (r.failed ? `, ${r.failed} failed` : '');

async function run(sub: string): Promise<void> {
  switch (sub) {
    case 'hook-start':
      await readStdin();
      await hookStart();
      return;
    case 'hook-end': {
      await readStdin();
      if (await pokeServer()) return;
      const ran = await indexLocked((db, { indexAll }) => {
        const r = indexAll(db);
        for (const e of r.errors) log(`index error ${e.path}: ${e.message}`);
      }, 0);
      if (!ran) log('hook-end: another indexer holds the lock; skipped');
      return;
    }
    case 'index': {
      const ran = await indexLocked((db, { indexAll }) => { console.log(summary(indexAll(db))); }, 5000);
      if (!ran) console.log('another indexer is running; skipped');
      return;
    }
    case 'backfill': {
      const startedAt = new Date().toISOString();
      const ran = await indexLocked((db, { indexAll }) => {
        const progress = (done: number, total: number, finishedAt?: string): void =>
          db.meta.set('backfill_progress', JSON.stringify({ done, total, startedAt, ...(finishedAt && { finishedAt }) }));
        progress(0, 0);
        let last = { done: 0, total: 0 };
        const r = indexAll(db, { onProgress: (done, total) => { last = { done, total }; progress(done, total); } });
        progress(last.done, last.total, new Date().toISOString());
        console.log(summary(r));
      }, 60000);
      if (!ran) console.log('another indexer is running; skipped');
      return;
    }
    default:
      console.error(`token-tracker: unknown command "${sub}"`);
  }
}

async function main(): Promise<void> {
  const sub = process.argv[2] ?? '';
  const nodeVersion = process.env.TOKEN_TRACKER_FAKE_NODE_VERSION || process.versions.node;
  if (nodeTooOld(nodeVersion)) {
    console.error(`Token Tracker needs Node 22.13 or newer (found ${nodeVersion}).`);
    return;
  }
  try {
    await run(sub);
  } catch (e) {
    log(`${sub} failed: ${errText(e)}`);
  }
}

await main();
process.exit(0);
