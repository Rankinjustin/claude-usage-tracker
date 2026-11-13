import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { projectsRoot } from '../core/paths';
import { priceCall } from '../core/prices';
import type { Db } from '../store/db';
import { parseLine, parseSubagentMeta } from './parse';

export interface IndexResult {
  files: number; newCalls: number; newPrompts: number; changedSessions: string[];
  /** Transcript bytes read this pass (0 when nothing changed). */
  bytesRead: number;
}

const CHUNK = 4 * 1024 * 1024;
const NL = 0x0a;
const SESSION_RE = /"sessionId"\s*:\s*"([^"]+)"/;

/** Transcripts say `claude-opus-5-5`; the price table and the store use `opus-5-5`. */
const shortModel = (m: string): string => m.replace(/^claude-/, '');

const empty = (): IndexResult => ({ files: 0, newCalls: 0, newPrompts: 0, changedSessions: [], bytesRead: 0 });

function add(into: IndexResult, r: IndexResult): void {
  into.files += r.files;
  into.newCalls += r.newCalls;
  into.newPrompts += r.newPrompts;
  into.bytesRead += r.bytesRead;
  for (const s of r.changedSessions) if (!into.changedSessions.includes(s)) into.changedSessions.push(s);
}

const dirEntries = (dir: string) => {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

/** `<root>/<project>/<session>.jsonl` first, then `<root>/<project>/<session>/subagents/agent-*.jsonl`. */
function listTranscripts(root: string): string[] {
  const mains: string[] = [];
  const subs: string[] = [];
  for (const p of dirEntries(root)) {
    if (!p.isDirectory()) continue;
    const proj = join(root, p.name);
    for (const e of dirEntries(proj)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) mains.push(join(proj, e.name));
      else if (e.isDirectory()) {
        const sub = join(proj, e.name, 'subagents');
        for (const s of dirEntries(sub)) {
          if (s.isFile() && s.name.startsWith('agent-') && s.name.endsWith('.jsonl')) subs.push(join(sub, s.name));
        }
      }
    }
  }
  return [...mains, ...subs];
}

/** Indexes every transcript under the root and marks vanished ones missing. */
export function indexAll(
  db: Db, opts: { root?: string; onProgress?: (done: number, total: number) => void } = {},
): IndexResult {
  const root = resolve(opts.root ?? projectsRoot());
  const files = listTranscripts(root);
  const out = empty();
  files.forEach((f, i) => {
    add(out, indexFile(db, f));
    opts.onProgress?.(i + 1, files.length);
  });
  const seen = new Set(files);
  for (const p of db.presentFiles()) {
    if (p.startsWith(root + sep) && !seen.has(p)) db.markFileMissing(p);
  }
  return out;
}

/** Indexes the complete lines a transcript gained since the last pass, in one transaction. */
export function indexFile(db: Db, path: string): IndexResult {
  const p = resolve(path);
  const prev = db.getFileState(p);
  let st;
  try { st = statSync(p); } catch {
    if (prev) db.markFileMissing(p);
    return empty();
  }
  const out = empty();
  out.files = 1;
  if (prev && !prev.missing && st.size === prev.size && st.mtimeMs === prev.mtimeMs) return out;

  const isSub = basename(dirname(p)) === 'subagents';
  let offset = prev?.offset ?? 0;
  const rescan = st.size < offset;
  if (rescan) offset = 0;

  const fd = openSync(p, 'r');
  try {
    db.transaction(() => {
      let sid = rescan ? null : prev?.sessionId ?? null;
      let runId = '';
      const promptKey = `lastPrompt:${p}`;
      let lastPrompt = isSub || offset === 0 ? null : db.meta.get(promptKey);
      let title: string | null = null;
      let cwd: string | null = null;
      let ccVersion: string | null = null;
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      let touched = false;
      const seenTs = (ts: string): void => {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      };

      const handle = (line: string): void => {
        for (const x of parseLine(line)) {
          if (x.kind === 'ignored' || x.kind === 'slash_command') continue;
          touched = true;
          switch (x.kind) {
            case 'api_part': {
              const model = shortModel(x.model);
              const pr = priceCall(model, x.tokens, x.ts, x.speed);
              const t = x.tokens;
              const isNew = db.upsertApiCall({
                messageId: x.messageId, sessionId: sid!, runId, promptUuid: lastPrompt, ts: x.ts, model,
                effort: x.effort, speed: x.speed, tokens: t,
                ctxTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
                cost: pr.cost, costPartsJson: pr.parts ? JSON.stringify(pr.parts) : null, priceId: pr.priceId,
                thinkingMs: x.thinkingMs, rawJson: x.raw, toolUses: x.toolUses,
                advisor: x.advisor.map((a) => {
                  const am = shortModel(a.model);
                  return { model: am, tokens: a.tokens, cost: priceCall(am, a.tokens, x.ts).cost };
                }),
              });
              if (isNew) out.newCalls++;
              cwd = x.cwd ?? cwd;
              ccVersion = x.ccVersion ?? ccVersion;
              seenTs(x.ts);
              break;
            }
            case 'prompt': {
              if (isSub) break; // a subagent's prompt comes from its launching tool call
              const uuid = x.uuid || `${sid}:${x.ts}`;
              const isNew = db.insertPrompt({ uuid, sessionId: sid!, ts: x.ts, text: x.text, durationMs: null });
              if (isNew) out.newPrompts++;
              lastPrompt = uuid;
              seenTs(x.ts);
              break;
            }
            case 'tool_result':
              db.completeToolCall(x.toolUseId, { endedTs: x.ts, resultChars: x.resultChars, isError: x.isError,
                denied: x.denied, permission: x.permission });
              break;
            case 'turn_duration':
              if (lastPrompt) db.setPromptDuration(lastPrompt, x.durationMs);
              break;
            case 'compaction':
              db.insertCompaction({ sessionId: sid!, runId, ts: x.ts, preTokens: x.preTokens,
                durationMs: x.durationMs, trigger: x.trigger });
              break;
            case 'hook_runs':
              db.insertHookRuns(sid!, x.ts, x.runs);
              break;
            case 'title':
              title = x.title;
              break;
          }
        }
      };

      // Read [offset, size) in chunks; only bytes up to the last newline are consumed.
      const buf = Buffer.allocUnsafe(CHUNK);
      let carry: Buffer = Buffer.alloc(0);
      let pos = offset;
      let consumed = offset;
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        out.bytesRead += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const last = data.lastIndexOf(NL);
        if (last < 0) { carry = Buffer.from(data); continue; }
        if (sid === null) {
          const m = SESSION_RE.exec(data.toString('utf8', 0, last));
          sid = m ? m[1] : isSub ? basename(dirname(dirname(p))) : basename(p, '.jsonl');
        }
        runId = isSub ? basename(p, '.jsonl') : `main:${sid}`;
        let start = 0;
        while (start <= last) {
          const end = data.indexOf(NL, start);
          let line = data.toString('utf8', start, end);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line) handle(line);
          start = end + 1;
        }
        consumed += last + 1; // consumed is the file offset of data[0]
        carry = Buffer.from(data.subarray(last + 1));
      }

      if (sid === null) sid = isSub ? basename(dirname(dirname(p))) : basename(p, '.jsonl');
      runId = isSub ? basename(p, '.jsonl') : `main:${sid}`;
      if (touched) {
        const project = basename(isSub ? dirname(dirname(dirname(p))) : dirname(p));
        db.upsertSession({ id: sid, title, project, cwd, firstTs, lastTs, ccVersion });
        upsertRunFor(db, p, isSub, sid, runId);
        out.changedSessions.push(sid);
      }
      if (!isSub && lastPrompt) db.meta.set(promptKey, lastPrompt);
      db.setFileState(p, { size: st.size, mtimeMs: st.mtimeMs, offset: consumed, sessionId: sid, runId });
    });
  } finally {
    closeSync(fd);
  }
  return out;
}

function upsertRunFor(db: Db, p: string, isSub: boolean, sid: string, runId: string): void {
  if (!isSub) {
    db.upsertRun({ id: runId, sessionId: sid, agentType: 'main', description: null, launchToolUseId: null,
      parentRunId: null, file: p });
    return;
  }
  const metaPath = p.replace(/\.jsonl$/, '.meta.json');
  const meta = parseSubagentMeta(existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : '');
  const launcher = meta.toolUseId
    ? db.raw.prepare('SELECT run_id FROM tool_calls WHERE tool_use_id = ?').get(meta.toolUseId) as
      { run_id: string } | undefined
    : undefined;
  const parent = launcher?.run_id ?? (meta.spawnDepth <= 1 ? `main:${sid}` : null);
  db.upsertRun({ id: runId, sessionId: sid, agentType: meta.agentType, description: meta.description || null,
    launchToolUseId: meta.toolUseId, parentRunId: parent, file: p });
}
