// src/server/server.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync as existsSync5, readFileSync as readFileSync4, realpathSync, rmSync, statSync as statSync3, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve as resolve2, sep as sep2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/paths.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function dataHome(home = homedir()) {
  return process.env.TOKEN_TRACKER_HOME || join(home, ".claude", "token-tracker");
}
function projectsRoot(home = homedir()) {
  const base = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return join(base, "projects");
}
function dbPath() {
  return join(dataHome(), "tracker.db");
}
function stateFile(name) {
  return join(dataHome(), name);
}
function restrictWindows(dir) {
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
  } catch {
  }
}
function ensureDataHome() {
  const dir = dataHome();
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 448 });
  if (!existed && process.platform === "win32") restrictWindows(dir);
  return dir;
}

// src/ingest/indexer.ts
import { closeSync, existsSync as existsSync2, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join as join2, resolve, sep } from "node:path";

// src/core/prices.ts
var row = (model, input, output, cacheWrite5m, cacheWrite1h, cacheRead, extra = {}) => ({
  id: `${model}@2026-01-01`,
  model,
  effectiveFrom: "2026-01-01",
  input,
  output,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  ...extra
});
var PRICES = [
  row("fable-5-2", 8, 40, 10, 16, 0.2, { fastMultiplier: 2 }),
  row("opus-5-5", 4, 20, 5, 8, 0.2, { fastMultiplier: 2 }),
  row("sonnet-5-5", 2, 10, 2.5, 4, 0.1),
  row("haiku-5-5", 0.1, 0.5, 0.125, 0.2, 0.01, { longContextOver: 1e5, longContextMultiplier: 5 })
];
var NONE = { cost: null, parts: null, priceId: null };
function priceCall(model, tokens, at, speed = "standard") {
  const atMs = Date.parse(at);
  let r;
  for (const p of PRICES) {
    if (p.model !== model || Date.parse(p.effectiveFrom) > atMs) continue;
    if (!r || Date.parse(p.effectiveFrom) > Date.parse(r.effectiveFrom)) r = p;
  }
  if (!r) return NONE;
  let m = speed === "fast" && r.fastMultiplier ? r.fastMultiplier : 1;
  const prompt = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  if (r.longContextOver !== void 0 && prompt > r.longContextOver) m *= r.longContextMultiplier ?? 1;
  const c = (n, rate) => n * rate * m / 1e6;
  const parts = {
    input: c(tokens.input, r.input),
    cacheWrite5m: c(tokens.cacheWrite5m, r.cacheWrite5m),
    cacheWrite1h: c(tokens.cacheWrite1h, r.cacheWrite1h),
    cacheRead: c(tokens.cacheRead, r.cacheRead),
    output: c(tokens.output, r.output),
    thinking: c(tokens.thinking, r.output)
  };
  const cost = parts.input + parts.cacheWrite5m + parts.cacheWrite1h + parts.cacheRead + parts.output + parts.thinking;
  return { cost, parts, priceId: r.id };
}

// src/ingest/parse.ts
var ignored = () => [{ kind: "ignored" }];
var NOT_PROMPT_PREFIXES = ["<local-command", "<system-reminder>", "<task-notification", "Caveat:"];
var IMAGE_CHARS = 6e3;
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
var str = (v) => typeof v === "string" ? v : null;
function toolLabel(name, input) {
  if (name === "Skill") {
    const skill = typeof input.skill === "string" ? input.skill : null;
    return { label: `Skill: ${skill ?? "?"}`, skill };
  }
  if (name === "Agent" || name === "Task") {
    const type = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
    return { label: `Agent: ${type}`, skill: null };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { label: `MCP ${parts[1].replace(/^claude_ai_/, "")}: ${parts.slice(2).join("__")}`, skill: null };
  }
  return { label: name, skill: null };
}
function parseSubagentMeta(json) {
  let m;
  try {
    m = JSON.parse(json);
  } catch {
    m = null;
  }
  const o = isObj(m) ? m : {};
  return {
    agentType: str(o.agentType) ?? "subagent",
    description: str(o.description) ?? "",
    toolUseId: str(o.toolUseId),
    spawnDepth: typeof o.spawnDepth === "number" ? o.spawnDepth : 1
  };
}
function parseLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return ignored();
  }
  if (!isObj(rec)) return ignored();
  try {
    return parseRecord(rec, line);
  } catch {
    return ignored();
  }
}
function parseRecord(rec, raw) {
  switch (rec.type) {
    case "assistant":
      return parseAssistant(rec, raw);
    case "user":
      return parseUser(rec, raw);
    case "system":
      return parseSystem(rec);
    case "ai-title": {
      const sessionId = str(rec.sessionId);
      const title = str(rec.aiTitle);
      return sessionId !== null && title !== null ? [{ kind: "title", sessionId, title }] : ignored();
    }
    default:
      return ignored();
  }
}
function tokensOf(u, thinking) {
  const cc = isObj(u.cache_creation) ? u.cache_creation : null;
  const hasTiers = cc !== null && (typeof cc.ephemeral_5m_input_tokens === "number" || typeof cc.ephemeral_1h_input_tokens === "number");
  return {
    input: num(u.input_tokens),
    cacheWrite5m: hasTiers ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
    cacheWrite1h: hasTiers ? num(cc.ephemeral_1h_input_tokens) : 0,
    cacheRead: num(u.cache_read_input_tokens),
    output: Math.max(0, num(u.output_tokens) - thinking),
    thinking
  };
}
function parseAssistant(rec, raw) {
  const msg = rec.message;
  if (!isObj(msg)) return ignored();
  const model = str(msg.model);
  if (!model || model === "<synthetic>") return ignored();
  const messageId = str(msg.id) ?? str(rec.requestId);
  const ts = str(rec.timestamp);
  const usage = msg.usage;
  if (!messageId || !ts || !isObj(usage)) return ignored();
  const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const tokens = tokensOf(usage, num(details.thinking_tokens));
  const advisor = [];
  if (Array.isArray(usage.iterations)) {
    for (const it of usage.iterations) {
      if (isObj(it) && it.type === "advisor_message") {
        advisor.push({ model: str(it.model) ?? model, tokens: tokensOf(it, 0) });
      }
    }
  }
  const toolUses = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!isObj(b) || b.type !== "tool_use") continue;
      const id = str(b.id);
      const name = str(b.name);
      if (!id || !name) continue;
      const input = isObj(b.input) ? b.input : {};
      const inputJson = JSON.stringify(input);
      toolUses.push({ id, name, ...toolLabel(name, input), inputJson, inputChars: inputJson.length });
    }
  }
  return [{
    kind: "api_part",
    messageId,
    sessionId: str(rec.sessionId) ?? "",
    ts,
    model,
    effort: str(rec.effort),
    speed: usage.speed === "fast" ? "fast" : "standard",
    tokens,
    advisor,
    thinkingMs: typeof rec.thinkingDurationMs === "number" ? rec.thinkingDurationMs : null,
    cwd: str(rec.cwd),
    gitBranch: str(rec.gitBranch),
    ccVersion: str(rec.version),
    toolUses,
    raw
  }];
}
function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (isObj(b) && b.type === "text") n += (str(b.text) ?? "").length;
    else if (isObj(b) && b.type === "image") n += IMAGE_CHARS;
    else n += JSON.stringify(b).length;
  }
  return n;
}
function parseUser(rec, raw) {
  const ts = str(rec.timestamp);
  const msg = rec.message;
  if (!ts || !isObj(msg)) return ignored();
  const content = msg.content;
  const blocks = Array.isArray(content) ? content.filter(isObj) : [];
  const results = blocks.filter((b) => b.type === "tool_result" && str(b.tool_use_id));
  if (results.length > 0) {
    const pd = rec.permissionDecision;
    const permission = typeof pd === "string" ? pd : isObj(pd) ? JSON.stringify(pd) : null;
    return results.map((b) => ({
      kind: "tool_result",
      toolUseId: b.tool_use_id,
      ts,
      isError: b.is_error === true,
      resultChars: resultChars(b.content),
      permission,
      denied: Boolean(rec.toolDenialKind),
      raw
    }));
  }
  if (rec.isMeta === true || rec.isCompactSummary === true || rec.isSidechain === true) return ignored();
  const text = typeof content === "string" ? content : blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n");
  if (!text) return ignored();
  const head = text.trimStart();
  const cmd = /^<command-(?:message|name)>/.test(head) ? /<command-name>\/?([^<]*)<\/command-name>/.exec(text) : null;
  if (cmd) return [{ kind: "slash_command", ts, name: cmd[1] }];
  if (NOT_PROMPT_PREFIXES.some((p) => head.startsWith(p))) return ignored();
  return [{ kind: "prompt", uuid: str(rec.uuid) ?? "", sessionId: str(rec.sessionId) ?? "", ts, text, raw }];
}
function parseSystem(rec) {
  const ts = str(rec.timestamp);
  if (!ts) return ignored();
  switch (rec.subtype) {
    case "turn_duration":
      return [{ kind: "turn_duration", ts, durationMs: num(rec.durationMs) }];
    case "compact_boundary": {
      const m = isObj(rec.compactMetadata) ? rec.compactMetadata : {};
      return [{
        kind: "compaction",
        ts,
        preTokens: num(m.preTokens),
        durationMs: num(m.durationMs),
        trigger: str(m.trigger) ?? ""
      }];
    }
    case "stop_hook_summary": {
      const infos = Array.isArray(rec.hookInfos) ? rec.hookInfos.filter(isObj) : [];
      return [{
        kind: "hook_runs",
        ts,
        runs: infos.map((h) => ({ command: str(h.command) ?? "", durationMs: num(h.durationMs) }))
      }];
    }
    default:
      return ignored();
  }
}

// src/ingest/indexer.ts
var CHUNK = 4 * 1024 * 1024;
var NL = 10;
var SESSION_RE = /"sessionId"\s*:\s*"([^"]+)"/;
var shortModel = (m) => m.replace(/^claude-/, "");
var empty = () => ({
  files: 0,
  newCalls: 0,
  newPrompts: 0,
  changedSessions: [],
  bytesRead: 0,
  failed: 0,
  errors: []
});
function add(into, r) {
  into.files += r.files;
  into.newCalls += r.newCalls;
  into.newPrompts += r.newPrompts;
  into.bytesRead += r.bytesRead;
  into.failed += r.failed;
  into.errors.push(...r.errors);
  for (const s of r.changedSessions) if (!into.changedSessions.includes(s)) into.changedSessions.push(s);
}
var dirEntries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
function listTranscripts(root) {
  const mains = [];
  const subs = [];
  for (const p of dirEntries(root)) {
    if (!p.isDirectory()) continue;
    const proj = join2(root, p.name);
    for (const e of dirEntries(proj)) {
      if (e.isFile() && e.name.endsWith(".jsonl")) mains.push(join2(proj, e.name));
      else if (e.isDirectory()) {
        const sub = join2(proj, e.name, "subagents");
        for (const s of dirEntries(sub)) {
          if (s.isFile() && s.name.startsWith("agent-") && s.name.endsWith(".jsonl")) subs.push(join2(sub, s.name));
        }
      }
    }
  }
  return [...mains, ...subs];
}
function indexAll(db, opts = {}) {
  const root = resolve(opts.root ?? projectsRoot());
  const files = listTranscripts(root);
  const out = empty();
  files.forEach((f, i) => {
    try {
      add(out, indexFile(db, f));
    } catch (e) {
      out.failed++;
      out.errors.push({ path: f, message: e instanceof Error ? e.message : String(e) });
    }
    opts.onProgress?.(i + 1, files.length);
  });
  const seen = new Set(files);
  for (const p of db.presentFiles()) {
    if (p.startsWith(root + sep) && !seen.has(p)) db.markFileMissing(p);
  }
  db.resolveRunParents();
  return out;
}
function indexFile(db, path, opts = {}) {
  const p = resolve(path);
  const prev = db.getFileState(p);
  let st;
  try {
    st = statSync(p);
  } catch {
    if (prev) db.markFileMissing(p);
    return empty();
  }
  const out = empty();
  out.files = 1;
  if (prev && !prev.missing && st.size === prev.size && st.mtimeMs === prev.mtimeMs) return out;
  const isSub = basename(dirname(p)) === "subagents";
  let offset = prev?.offset ?? 0;
  const rescan = st.size < offset;
  if (rescan) offset = 0;
  let fd;
  try {
    fd = openSync(p, "r");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    if (prev) db.markFileMissing(p);
    return empty();
  }
  try {
    db.transaction(() => {
      let sid = rescan ? null : prev?.sessionId ?? null;
      let runId = "";
      const promptKey = `lastPrompt:${p}`;
      let lastPrompt = isSub || offset === 0 ? null : db.meta.get(promptKey);
      if (!isSub && offset === 0) db.meta.delete(promptKey);
      let title = null;
      let cwd = null;
      let ccVersion = null;
      let firstTs = null;
      let lastTs = null;
      let touched = false;
      const seenTs = (ts) => {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      };
      const handle = (line) => {
        for (const x of parseLine(line)) {
          if (x.kind === "ignored" || x.kind === "slash_command") continue;
          touched = true;
          switch (x.kind) {
            case "api_part": {
              const model = shortModel(x.model);
              const pr = priceCall(model, x.tokens, x.ts, x.speed);
              const t = x.tokens;
              const isNew = db.upsertApiCall({
                messageId: x.messageId,
                sessionId: sid,
                runId,
                promptUuid: lastPrompt,
                ts: x.ts,
                model,
                effort: x.effort,
                speed: x.speed,
                tokens: t,
                ctxTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
                cost: pr.cost,
                costPartsJson: pr.parts ? JSON.stringify(pr.parts) : null,
                priceId: pr.priceId,
                thinkingMs: x.thinkingMs,
                rawJson: x.raw,
                toolUses: x.toolUses,
                advisor: x.advisor.map((a) => {
                  const am = shortModel(a.model);
                  return { model: am, tokens: a.tokens, cost: priceCall(am, a.tokens, x.ts).cost };
                })
              });
              if (isNew) out.newCalls++;
              cwd = x.cwd ?? cwd;
              ccVersion = x.ccVersion ?? ccVersion;
              seenTs(x.ts);
              break;
            }
            case "prompt": {
              if (isSub) break;
              const uuid = x.uuid || `${sid}:${x.ts}`;
              const isNew = db.insertPrompt({ uuid, sessionId: sid, ts: x.ts, text: x.text, durationMs: null });
              if (isNew) out.newPrompts++;
              lastPrompt = uuid;
              seenTs(x.ts);
              break;
            }
            case "tool_result":
              db.completeToolCall(x.toolUseId, {
                endedTs: x.ts,
                resultChars: x.resultChars,
                isError: x.isError,
                denied: x.denied,
                permission: x.permission
              });
              break;
            case "turn_duration":
              if (lastPrompt) db.setPromptDuration(lastPrompt, x.durationMs);
              break;
            case "compaction":
              db.insertCompaction({
                sessionId: sid,
                runId,
                ts: x.ts,
                preTokens: x.preTokens,
                durationMs: x.durationMs,
                trigger: x.trigger
              });
              break;
            case "hook_runs":
              db.insertHookRuns(sid, x.ts, x.runs);
              break;
            case "title":
              title = x.title;
              break;
          }
        }
      };
      const chunk = opts.chunkSize ?? CHUNK;
      const buf = Buffer.allocUnsafe(chunk);
      let carry = Buffer.alloc(0);
      let pos = offset;
      let consumed = offset;
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, Math.min(chunk, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        out.bytesRead += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const last = data.lastIndexOf(NL);
        if (last < 0) {
          carry = Buffer.from(data);
          continue;
        }
        if (sid === null) {
          const m = SESSION_RE.exec(data.toString("utf8", 0, last));
          sid = m ? m[1] : isSub ? basename(dirname(dirname(p))) : basename(p, ".jsonl");
        }
        runId = isSub ? basename(p, ".jsonl") : `main:${sid}`;
        let start = 0;
        while (start <= last) {
          const end = data.indexOf(NL, start);
          let line = data.toString("utf8", start, end);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line) handle(line);
          start = end + 1;
        }
        consumed += last + 1;
        carry = Buffer.from(data.subarray(last + 1));
      }
      if (sid === null) sid = isSub ? basename(dirname(dirname(p))) : basename(p, ".jsonl");
      runId = isSub ? basename(p, ".jsonl") : `main:${sid}`;
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
function upsertRunFor(db, p, isSub, sid, runId) {
  if (!isSub) {
    db.upsertRun({
      id: runId,
      sessionId: sid,
      agentType: "main",
      description: null,
      launchToolUseId: null,
      parentRunId: null,
      file: p
    });
    return;
  }
  const metaPath = p.replace(/\.jsonl$/, ".meta.json");
  const meta = parseSubagentMeta(existsSync2(metaPath) ? readFileSync(metaPath, "utf8") : "");
  const launcher = meta.toolUseId ? db.raw.prepare("SELECT run_id FROM tool_calls WHERE tool_use_id = ?").get(meta.toolUseId) : void 0;
  const parent = launcher?.run_id ?? (meta.spawnDepth <= 1 ? `main:${sid}` : null);
  db.upsertRun({
    id: runId,
    sessionId: sid,
    agentType: meta.agentType,
    description: meta.description || null,
    launchToolUseId: meta.toolUseId,
    parentRunId: parent,
    file: p
  });
}

// src/ingest/lock.ts
import { closeSync as closeSync2, openSync as openSync2, readFileSync as readFileSync2, statSync as statSync2, unlinkSync, writeSync } from "node:fs";
import { join as join3 } from "node:path";
var STALE_MS = 10 * 60 * 1e3;
var sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
var CORRUPT_GRACE_MS = 3e4;
function staleContent(path) {
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch {
    return null;
  }
  try {
    const { pid, ts } = JSON.parse(text);
    if (typeof pid !== "number") return text;
    return !pidAlive(pid) || typeof ts !== "number" || !(Date.now() - ts < STALE_MS) ? text : null;
  } catch {
    try {
      return Date.now() - statSync2(path).mtimeMs > CORRUPT_GRACE_MS ? text : null;
    } catch {
      return null;
    }
  }
}
function takeOver(path) {
  const seen = staleContent(path);
  if (seen === null) return false;
  try {
    if (readFileSync2(path, "utf8") !== seen) return false;
    unlinkSync(path);
  } catch {
  }
  return true;
}
function tryAcquire(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync2(path, "wx", 384);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        closeSync2(fd);
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!takeOver(path)) return false;
    }
  }
  return false;
}
function withWriteLock(fn, opts = {}) {
  ensureDataHome();
  const path = join3(dataHome(), "write.lock");
  const deadline = Date.now() + (opts.waitMs ?? 0);
  while (!tryAcquire(path)) {
    if (Date.now() >= deadline) return "busy";
    sleep(50);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
    }
  }
}

// src/query/views.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";

// src/query/ranges.ts
function dayStart(d, offset = 0) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
}
function parseBound(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
}
function resolveRange(r, now = /* @__PURE__ */ new Date()) {
  const iso = (d) => d.toISOString();
  if ("preset" in r) {
    const days = { today: 1, week: 7, month: 30, all: 0 }[r.preset];
    const to2 = dayStart(now, 1);
    if (days === 0) {
      const from3 = "1970-01-01T00:00:00.000Z";
      return { from: from3, to: iso(to2), prevFrom: from3, prevTo: from3 };
    }
    const from2 = dayStart(now, 1 - days);
    return { from: iso(from2), to: iso(to2), prevFrom: iso(dayStart(now, 1 - 2 * days)), prevTo: iso(from2) };
  }
  const from = parseBound(r.from);
  const to = parseBound(r.to);
  const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  return { from: iso(from), to: iso(to), prevFrom: iso(prevFrom), prevTo: iso(from) };
}

// src/query/views.ts
var PART_KEYS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output", "thinking"];
var COL = {
  input: "input",
  cacheWrite5m: "cache_write_5m",
  cacheWrite1h: "cache_write_1h",
  cacheRead: "cache_read",
  output: "output",
  thinking: "thinking"
};
var BUILT_IN = /* @__PURE__ */ new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "fork"]);
var FLAG_MULTIPLE = 3;
var FLAG_MIN_PRIOR = 5;
var SPARK_RUNS = 20;
var WITH_CALLS = `WITH RECURSIVE
rp(run_id, prompt_uuid, nxt, depth) AS (
  SELECT r.id, t.prompt_uuid, t.run_id, 0 FROM runs r JOIN tool_calls t ON t.tool_use_id = r.launch_tool_use_id
  UNION ALL
  SELECT rp.run_id, t2.prompt_uuid, t2.run_id, rp.depth + 1
  FROM rp JOIN runs pr ON pr.id = rp.nxt JOIN tool_calls t2 ON t2.tool_use_id = pr.launch_tool_use_id
  WHERE rp.prompt_uuid IS NULL AND rp.depth < 8
),
rpf AS (SELECT run_id, prompt_uuid FROM rp WHERE prompt_uuid IS NOT NULL),
calls AS (
  SELECT c.message_id, c.session_id, c.run_id, c.ts, c.model, c.ctx_tokens, c.input, c.cache_write_5m,
    c.cache_write_1h, c.cache_read, c.output, c.thinking, c.cost, c.cost_parts_json,
    COALESCE((SELECT SUM(a.cost) FROM advisor_calls a WHERE a.message_id = c.message_id), 0) AS adv,
    COALESCE(c.prompt_uuid, rpf.prompt_uuid) AS eff_prompt,
    (r.agent_type IS NULL OR r.agent_type = 'main') AS is_main,
    COALESCE(r.agent_type, 'main') AS agent_type
  FROM api_calls c LEFT JOIN runs r ON r.id = c.run_id LEFT JOIN rpf ON rpf.run_id = c.run_id
)`;
var CALL_COST = "(COALESCE(cost, 0) + adv)";
function all(db, sql, ...p) {
  return db.raw.prepare(sql).all(...p);
}
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
var pct = (part, whole) => whole > 0 ? part / whole * 100 : 0;
function cacheHit(read, w5, w1, input) {
  return pct(read, read + w5 + w1 + input);
}
function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function agentKind(type) {
  return type === "main" ? "main" : BUILT_IN.has(type) ? "built-in" : "custom";
}
var sumTokens = (t) => Object.values(t).reduce((a, b) => a + b, 0);
function parseParts(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
function advisorTokens(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
function takeaway(parts, total, calls, storeHasCalls) {
  if (calls === 0) return storeHasCalls ? "No usage in this period." : "No usage recorded yet.";
  if (total <= 0) return "No priced usage in this range.";
  const groups = [
    ["Cache reads and writes", parts.cacheRead + parts.cacheWrite5m + parts.cacheWrite1h],
    ["Output and thinking", parts.output + parts.thinking],
    ["Advisor calls", parts.advisor],
    ["Input tokens", parts.input]
  ];
  groups.sort((a, b) => b[1] - a[1]);
  return `${groups[0][0]} were ${Math.round(pct(groups[0][1], total))}% of spend.`;
}
function overview(db, r, now) {
  const rg = resolveRange(r, now);
  const rows = all(db, `${WITH_CALLS} SELECT ts, session_id, is_main, ctx_tokens, input, cache_write_5m, cache_write_1h,
    cache_read, output, thinking, cost, cost_parts_json FROM calls WHERE ts >= ? AND ts < ?`, rg.from, rg.to);
  const tok = {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    advisor: 0
  };
  const cost = { ...tok };
  const daily = /* @__PURE__ */ new Map();
  const heat = /* @__PURE__ */ new Map();
  const sessionIds = /* @__PURE__ */ new Set();
  let total = 0, agentCost = 0, unpricedCalls = 0, mainCtx = 0, mainCalls = 0;
  const day = (ts) => {
    const k = localDay(ts);
    let d = daily.get(k);
    if (!d) daily.set(k, d = { cost: 0, parts: {} });
    return d;
  };
  for (const row2 of rows) {
    sessionIds.add(row2.session_id);
    for (const k of PART_KEYS) tok[k] += row2[COL[k]];
    if (row2.is_main) {
      mainCtx += row2.ctx_tokens;
      mainCalls++;
    }
    if (row2.cost === null) {
      unpricedCalls++;
      continue;
    }
    total += row2.cost;
    if (!row2.is_main) agentCost += row2.cost;
    const d = day(row2.ts);
    d.cost += row2.cost;
    const parts = parseParts(row2.cost_parts_json);
    for (const k of PART_KEYS) {
      const v = parts[k] ?? 0;
      cost[k] += v;
      d.parts[k] = (d.parts[k] ?? 0) + v;
    }
    const dt = new Date(row2.ts);
    const hk = `${dt.getDay()}:${dt.getHours()}`;
    heat.set(hk, (heat.get(hk) ?? 0) + row2.cost);
  }
  const adv = all(db, `${WITH_CALLS} SELECT a.tokens_json, a.cost, k.ts, k.is_main FROM advisor_calls a
    JOIN calls k ON k.message_id = a.message_id WHERE k.ts >= ? AND k.ts < ?`, rg.from, rg.to);
  for (const a of adv) {
    tok.advisor += sumTokens(advisorTokens(a.tokens_json));
    if (a.cost === null) continue;
    cost.advisor += a.cost;
    total += a.cost;
    if (!a.is_main) agentCost += a.cost;
    const d = day(a.ts);
    d.cost += a.cost;
    d.parts.advisor = (d.parts.advisor ?? 0) + a.cost;
    const dt = new Date(a.ts);
    const hk = `${dt.getDay()}:${dt.getHours()}`;
    heat.set(hk, (heat.get(hk) ?? 0) + a.cost);
  }
  const prev = all(
    db,
    `${WITH_CALLS} SELECT COALESCE(SUM(${CALL_COST}), 0) AS c FROM calls WHERE ts >= ? AND ts < ?`,
    rg.prevFrom,
    rg.prevTo
  )[0].c;
  const prompts2 = all(db, "SELECT COUNT(*) AS n FROM prompts WHERE ts >= ? AND ts < ?", rg.from, rg.to)[0].n;
  const keys = [...PART_KEYS, "advisor"];
  return {
    total,
    prevTotal: prev,
    tokens: sumTokens(tok),
    calls: rows.length,
    unpricedCalls,
    sessions: sessionIds.size,
    prompts: prompts2,
    cacheHitPct: cacheHit(tok.cacheRead, tok.cacheWrite5m, tok.cacheWrite1h, tok.input),
    parts: keys.map((key) => ({ key, tokens: tok[key], cost: cost[key], pct: pct(cost[key], total) })),
    daily: [...daily.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([d, v]) => ({ day: d, ...v })),
    heat: [...heat.entries()].map(([k, c]) => {
      const [weekday, hour] = k.split(":").map(Number);
      return { weekday, hour, cost: c };
    }),
    subagentPct: pct(agentCost, total),
    mainAvgCtx: mainCalls ? Math.round(mainCtx / mainCalls) : 0,
    takeaway: takeaway(
      cost,
      total,
      rows.length,
      rows.length > 0 || all(db, "SELECT 1 FROM api_calls LIMIT 1").length > 0
    )
  };
}
function allRuns(db, activeSince) {
  const scope = activeSince ? `WHERE r.agent_type IN (SELECT r2.agent_type FROM runs r2 JOIN api_calls c2 ON c2.run_id = r2.id
        WHERE c2.ts >= ? AND r2.agent_type <> 'main')` : "";
  const rows = all(db, `${WITH_CALLS}
    SELECT r.id, r.agent_type, r.description, r.session_id, MIN(k.ts) AS start, MAX(k.ts) AS last_call,
      (SELECT MAX(t.ended_ts) FROM tool_calls t WHERE t.run_id = r.id) AS last_tool,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = r.id) AS tool_n,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = r.id AND t.is_error = 1) AS tool_err,
      SUM(${CALL_COST}) AS cost, COUNT(k.message_id) AS calls, SUM(k.ctx_tokens) AS ctx_sum,
      rpf.prompt_uuid AS prompt_uuid, p.text AS prompt_text
    FROM runs r JOIN calls k ON k.run_id = r.id LEFT JOIN rpf ON rpf.run_id = r.id
      LEFT JOIN prompts p ON p.uuid = rpf.prompt_uuid
    ${scope}
    GROUP BY r.id ORDER BY start, r.id`, ...activeSince ? [activeSince] : []);
  const prior = /* @__PURE__ */ new Map();
  return rows.map((x) => {
    let flagged = false;
    if (x.agent_type !== "main") {
      const costs = prior.get(x.agent_type) ?? [];
      flagged = costs.length >= FLAG_MIN_PRIOR && x.cost > FLAG_MULTIPLE * median(costs);
      costs.push(x.cost);
      prior.set(x.agent_type, costs);
    }
    const end = [x.last_call, x.last_tool].filter(Boolean).sort().pop();
    return {
      id: x.id,
      agentType: x.agent_type,
      description: x.description,
      start: x.start,
      durationMs: Math.max(0, Date.parse(end) - Date.parse(x.start)),
      cost: x.cost,
      calls: x.calls,
      promptUuid: x.prompt_uuid,
      promptText: x.prompt_text,
      flagged,
      sessionId: x.session_id,
      ctxSum: x.ctx_sum,
      toolCalls: x.tool_n,
      toolErrors: x.tool_err
    };
  });
}
var toRunRow = ({ sessionId, ctxSum, toolCalls, toolErrors, ...run }) => run;
function sessionRows(db, from, to, id) {
  const idSql = id ? "AND s.id = ?" : "";
  const params = id ? [from, to, id] : [from, to];
  const rows = all(db, `${WITH_CALLS}
    SELECT s.id, s.title, s.project, s.first_ts, s.last_ts, SUM(${CALL_COST}) AS cost,
      SUM(CASE WHEN k.is_main THEN 0 ELSE ${CALL_COST} END) AS agent_cost, COUNT(*) AS calls,
      MAX(CASE WHEN k.is_main THEN k.ctx_tokens ELSE 0 END) AS peak,
      GROUP_CONCAT(DISTINCT k.model) AS models
    FROM sessions s JOIN calls k ON k.session_id = s.id WHERE k.ts >= ? AND k.ts < ? ${idSql}
    GROUP BY s.id ORDER BY s.first_ts DESC`, ...params);
  const startCtx = /* @__PURE__ */ new Map();
  const ids = rows.map((s) => s.id);
  const firstCalls = ids.length === 0 ? [] : all(db, `${WITH_CALLS} SELECT session_id, ctx_tokens FROM calls
    WHERE is_main AND session_id IN (${ids.map(() => "?").join(",")}) ORDER BY ts`, ...ids);
  for (const c of firstCalls) {
    if (!startCtx.has(c.session_id)) startCtx.set(c.session_id, c.ctx_tokens);
  }
  const compactions = /* @__PURE__ */ new Map();
  for (const c of all(db, `SELECT session_id, COUNT(*) AS n FROM compactions WHERE ts >= ? AND ts < ?
    GROUP BY session_id`, from, to)) compactions.set(c.session_id, c.n);
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    project: s.project,
    start: s.first_ts,
    durationMin: Math.round((Date.parse(s.last_ts) - Date.parse(s.first_ts)) / 6e4),
    calls: s.calls,
    cost: s.cost,
    agentCost: s.agent_cost,
    peakCtx: s.peak,
    startCtx: startCtx.get(s.id) ?? 0,
    compactions: compactions.get(s.id) ?? 0,
    models: String(s.models ?? "").split(",").filter(Boolean).sort()
  }));
}
function sessions(db, r, now) {
  const rg = resolveRange(r, now);
  return sessionRows(db, rg.from, rg.to);
}
function sessionDetail(db, id) {
  const session = sessionRows(db, "", "\uFFFF", id)[0] ?? null;
  const ps = promptRows(db, all(db, "SELECT * FROM prompts WHERE session_id = ? ORDER BY ts", id));
  const runs = allRuns(db).filter((x) => x.sessionId === id).map(toRunRow);
  const ctxSeries = all(db, `${WITH_CALLS} SELECT ts, ctx_tokens AS ctx FROM calls WHERE is_main AND session_id = ?
    ORDER BY ts`, id).map((c) => ({ ts: c.ts, ctx: c.ctx }));
  return { session, prompts: ps, runs, ctxSeries };
}
function promptTotals(db) {
  const m = /* @__PURE__ */ new Map();
  for (const x of all(db, `${WITH_CALLS} SELECT eff_prompt AS u,
      SUM(CASE WHEN is_main THEN ${CALL_COST} ELSE 0 END) AS main,
      SUM(CASE WHEN is_main THEN 0 ELSE ${CALL_COST} END) AS agent, COUNT(*) AS calls
    FROM calls WHERE eff_prompt IS NOT NULL GROUP BY eff_prompt`)) {
    m.set(x.u, { main: x.main, agent: x.agent, calls: x.calls });
  }
  return m;
}
function promptRows(db, rows, base = rows) {
  const totals = promptTotals(db);
  const t = (u) => {
    const x = totals.get(u);
    return x ? x.main + x.agent : 0;
  };
  const med = median(base.map((p) => t(p.uuid)).filter((v) => v > 0));
  const titles = new Map(all(db, "SELECT id, title FROM sessions").map((s) => [s.id, s.title]));
  return rows.map((p) => {
    const x = totals.get(p.uuid) ?? { main: 0, agent: 0, calls: 0 };
    const total = x.main + x.agent;
    return {
      uuid: p.uuid,
      sessionId: p.session_id,
      sessionTitle: titles.get(p.session_id) ?? null,
      ts: p.ts,
      text: p.text,
      cost: x.main,
      agentCost: x.agent,
      total,
      calls: x.calls,
      durationMs: p.duration_ms,
      multipleOfMedian: med > 0 ? total / med : null
    };
  });
}
function prompts(db, r, q, now) {
  const rg = resolveRange(r, now);
  const inRange = all(db, "SELECT * FROM prompts WHERE ts >= ? AND ts < ? ORDER BY ts DESC", rg.from, rg.to);
  const needle = q?.trim().toLowerCase();
  const shown = needle ? inRange.filter((p) => String(p.text).toLowerCase().includes(needle)) : inRange;
  return promptRows(db, shown, inRange);
}
function promptDetail(db, uuid) {
  const p = all(db, "SELECT * FROM prompts WHERE uuid = ?", uuid)[0];
  if (!p) return null;
  const prompt = promptRows(db, [p], all(db, "SELECT * FROM prompts"))[0];
  const calls = all(db, `${WITH_CALLS} SELECT run_id, agent_type, is_main, input, cache_write_5m, cache_write_1h,
    cache_read, output, thinking, cost, cost_parts_json, adv FROM calls WHERE eff_prompt = ?`, uuid);
  const tok = {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    advisor: 0
  };
  const cost = { ...tok };
  const byLabel = /* @__PURE__ */ new Map();
  const byRun = /* @__PURE__ */ new Map();
  for (const c of calls) {
    for (const k of PART_KEYS) tok[k] += c[COL[k]];
    const parts = parseParts(c.cost_parts_json);
    for (const k of PART_KEYS) cost[k] += parts[k] ?? 0;
    const callCost = (c.cost ?? 0) + c.adv;
    const label = c.is_main ? "Main thread" : c.agent_type;
    byLabel.set(label, (byLabel.get(label) ?? 0) + callCost);
    const br = byRun.get(c.run_id) ?? { cost: 0, calls: 0 };
    br.cost += callCost;
    br.calls++;
    byRun.set(c.run_id, br);
  }
  for (const a of all(db, `${WITH_CALLS} SELECT a.tokens_json, a.cost FROM advisor_calls a
    JOIN calls k ON k.message_id = a.message_id WHERE k.eff_prompt = ?`, uuid)) {
    tok.advisor += sumTokens(advisorTokens(a.tokens_json));
    cost.advisor += a.cost ?? 0;
  }
  const tools = all(db, `${WITH_CALLS} SELECT t.label, COUNT(*) AS calls, SUM(t.is_error) AS failed, SUM(t.denied) AS denied
    FROM tool_calls t LEFT JOIN rpf ON rpf.run_id = t.run_id WHERE COALESCE(t.prompt_uuid, rpf.prompt_uuid) = ?
    GROUP BY t.label ORDER BY calls DESC, t.label`, uuid);
  const advisorCalls = all(db, `${WITH_CALLS} SELECT COUNT(*) AS n FROM advisor_calls a
    JOIN calls k ON k.message_id = a.message_id WHERE k.eff_prompt = ?`, uuid)[0].n;
  const runs = allRuns(db).filter((x) => byRun.has(x.id)).map((x) => ({
    ...toRunRow(x),
    cost: byRun.get(x.id).cost,
    calls: byRun.get(x.id).calls,
    promptUuid: uuid,
    promptText: p.text
  }));
  const keys = [...PART_KEYS, "advisor"];
  return {
    prompt,
    summary: {
      cost: prompt.cost,
      agentCost: prompt.agentCost,
      durationMs: prompt.durationMs,
      tokens: sumTokens(tok),
      cacheReadPct: cacheHit(tok.cacheRead, tok.cacheWrite5m, tok.cacheWrite1h, tok.input),
      apiCalls: calls.length,
      advisorCalls,
      toolCalls: tools.reduce((a, t) => a + t.calls, 0),
      failed: tools.reduce((a, t) => a + (t.failed ?? 0), 0),
      denied: tools.reduce((a, t) => a + (t.denied ?? 0), 0)
    },
    parts: keys.map((key) => ({ key, tokens: tok[key], cost: cost[key] })),
    byPart: [...byLabel.entries()].map(([label, c]) => ({ label, cost: c })).sort((a, b) => b.cost - a.cost),
    runs,
    tools: tools.map((t) => ({ label: t.label, calls: t.calls, failed: t.failed ?? 0 }))
  };
}
function agents(db, r, now) {
  const rg = resolveRange(r, now);
  const agg = all(
    db,
    `${WITH_CALLS} SELECT agent_type, COUNT(DISTINCT run_id) AS runs, COUNT(*) AS calls,
      SUM(${CALL_COST}) AS cost, SUM(ctx_tokens) AS ctx_sum FROM calls WHERE ts >= ? AND ts < ? GROUP BY agent_type`,
    rg.from,
    rg.to
  );
  const started = allRuns(db).filter((x) => x.start >= rg.from && x.start < rg.to);
  const grandTotal = agg.reduce((a, x) => a + x.cost, 0);
  return agg.map((x) => {
    const xs = started.filter((run) => run.agentType === x.agent_type);
    const toolN = xs.reduce((a, run) => a + run.toolCalls, 0);
    return {
      type: x.agent_type,
      kind: agentKind(x.agent_type),
      runs: x.runs,
      calls: x.calls,
      cost: x.cost,
      pct: pct(x.cost, grandTotal),
      perRun: x.cost / x.runs,
      avgCtx: Math.round(x.ctx_sum / x.calls),
      avgDurationMs: xs.length ? xs.reduce((a, run) => a + run.durationMs, 0) / xs.length : 0,
      errorRate: pct(xs.reduce((a, run) => a + run.toolErrors, 0), toolN),
      sparkline: xs.slice(-SPARK_RUNS).map((run) => run.cost),
      flaggedRuns: xs.filter((run) => run.flagged).length
    };
  }).sort((a, b) => b.cost - a.cost);
}
function agentDetail(db, type, r, now) {
  const rg = resolveRange(r, now);
  const runs = allRuns(db).filter((x) => x.agentType === type && x.start >= rg.from && x.start < rg.to);
  return {
    stats: agents(db, r, now).find((a) => a.type === type) ?? null,
    runs: runs.map(toRunRow),
    medianCost: median(runs.map((x) => x.cost))
  };
}
function installedAt() {
  try {
    const f = stateFile("installed.json");
    if (!existsSync3(f)) return null;
    const v = JSON.parse(readFileSync3(f, "utf8")).installedAt;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
function coverage(db) {
  const n = (sql) => all(db, sql)[0].n;
  const sessionsPartial = n(`SELECT COUNT(DISTINCT session_id) AS n FROM files WHERE missing = 1 AND session_id IS NOT NULL`);
  let progress = null;
  try {
    progress = JSON.parse(db.meta.get("backfill_progress") ?? "null");
  } catch {
  }
  const started = progress?.startedAt ?? null;
  return {
    installedAt: installedAt() ?? started,
    sessionsComplete: n("SELECT COUNT(*) AS n FROM sessions") - sessionsPartial,
    sessionsPartial,
    filesMissingBeforeIndexed: n("SELECT COUNT(*) AS n FROM files WHERE missing = 1"),
    backfillProgress: progress
  };
}

// src/store/db.ts
import { chmodSync, closeSync as closeSync3, existsSync as existsSync4, openSync as openSync3 } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// raw:C:\Development and Programming\token-tracker\src\store\schema.sql
var schema_default = 'CREATE TABLE sessions (\n  id TEXT PRIMARY KEY, title TEXT, project TEXT, cwd TEXT, first_ts TEXT, last_ts TEXT, cc_version TEXT\n);\nCREATE TABLE runs (\n  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL, description TEXT,\n  launch_tool_use_id TEXT, parent_run_id TEXT, file TEXT\n);\nCREATE INDEX runs_session ON runs(session_id);\nCREATE TABLE prompts (\n  uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL, duration_ms INTEGER\n);\nCREATE INDEX prompts_session_ts ON prompts(session_id, ts);\nCREATE TABLE api_calls (\n  message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt_uuid TEXT,\n  ts TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, speed TEXT NOT NULL,\n  input INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,\n  cache_read INTEGER NOT NULL, output INTEGER NOT NULL, thinking INTEGER NOT NULL,\n  ctx_tokens INTEGER NOT NULL, cost REAL, cost_parts_json TEXT, price_id TEXT, thinking_ms INTEGER, raw_json TEXT\n);\nCREATE INDEX api_calls_ts ON api_calls(ts);\nCREATE INDEX api_calls_session ON api_calls(session_id);\nCREATE INDEX api_calls_run ON api_calls(run_id);\nCREATE INDEX api_calls_prompt ON api_calls(prompt_uuid);\nCREATE TABLE advisor_calls (\n  message_id TEXT NOT NULL, model TEXT NOT NULL, tokens_json TEXT NOT NULL, cost REAL\n);\nCREATE INDEX advisor_calls_message ON advisor_calls(message_id);\nCREATE TABLE tool_calls (\n  tool_use_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt_uuid TEXT,\n  name TEXT NOT NULL, label TEXT NOT NULL, skill TEXT, input_json TEXT, started_ts TEXT, ended_ts TEXT,\n  result_chars INTEGER, is_error INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, permission TEXT\n);\nCREATE INDEX tool_calls_run ON tool_calls(run_id);\nCREATE INDEX tool_calls_prompt ON tool_calls(prompt_uuid);\nCREATE TABLE pending_results (\n  tool_use_id TEXT PRIMARY KEY, ended_ts TEXT, result_chars INTEGER, is_error INTEGER, denied INTEGER, permission TEXT\n);\nCREATE TABLE compactions (\n  session_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL, pre_tokens INTEGER, duration_ms INTEGER, trigger TEXT\n);\nCREATE TABLE hook_runs (\n  session_id TEXT NOT NULL, ts TEXT NOT NULL, command TEXT NOT NULL, duration_ms INTEGER\n);\nCREATE TABLE files (\n  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, "offset" INTEGER NOT NULL,\n  session_id TEXT, run_id TEXT, missing INTEGER NOT NULL DEFAULT 0\n);\nCREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);\n';

// src/store/db.ts
var MIGRATIONS = [
  schema_default,
  // v2: compactions and hook runs are keyed so a rescan from offset 0 cannot duplicate them.
  `DELETE FROM compactions WHERE rowid NOT IN (SELECT MIN(rowid) FROM compactions GROUP BY session_id, ts);
   CREATE UNIQUE INDEX compactions_key ON compactions(session_id, ts);
   DELETE FROM hook_runs WHERE rowid NOT IN (SELECT MIN(rowid) FROM hook_runs GROUP BY session_id, ts, command);
   CREATE UNIQUE INDEX hook_runs_key ON hook_runs(session_id, ts, command);`
];
var flag = (b) => b ? 1 : 0;
function migrate(raw) {
  const row2 = raw.prepare("PRAGMA user_version").get();
  for (let v = row2.user_version; v < MIGRATIONS.length; v++) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec("COMMIT");
    } catch (e) {
      raw.exec("ROLLBACK");
      throw e;
    }
  }
}
function openDb(path) {
  if (path === dbPath()) ensureDataHome();
  const existed = existsSync4(path);
  if (!existed && process.platform !== "win32") closeSync3(openSync3(path, "a", 384));
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  migrate(raw);
  if (!existed && process.platform !== "win32") {
    try {
      chmodSync(path, 384);
    } catch {
    }
  }
  const stmts = /* @__PURE__ */ new Map();
  const q = (sql) => {
    let st = stmts.get(sql);
    if (!st) {
      st = raw.prepare(sql);
      stmts.set(sql, st);
    }
    return st;
  };
  const run = (sql, ...p) => {
    q(sql).run(...p);
  };
  const insertToolCall = (t) => {
    const r = q(`INSERT OR IGNORE INTO tool_calls
      (tool_use_id, message_id, run_id, prompt_uuid, name, label, skill, input_json, started_ts)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(t.toolUseId, t.messageId, t.runId, t.promptUuid, t.name, t.label, t.skill, t.inputJson, t.startedTs);
    if (r.changes === 0) return;
    const p = q("SELECT * FROM pending_results WHERE tool_use_id = ?").get(t.toolUseId);
    if (!p) return;
    run(
      `UPDATE tool_calls SET ended_ts=?, result_chars=?, is_error=?, denied=?, permission=? WHERE tool_use_id=?`,
      p.ended_ts,
      p.result_chars,
      p.is_error,
      p.denied,
      p.permission,
      t.toolUseId
    );
    run("DELETE FROM pending_results WHERE tool_use_id = ?", t.toolUseId);
  };
  let depth = 0;
  const db = {
    raw,
    upsertSession(s) {
      run(
        `INSERT INTO sessions (id, title, project, cwd, first_ts, last_ts, cc_version) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, title), project = COALESCE(excluded.project, project),
          cwd = COALESCE(excluded.cwd, cwd), cc_version = COALESCE(excluded.cc_version, cc_version),
          first_ts = CASE WHEN first_ts IS NULL OR excluded.first_ts < first_ts THEN excluded.first_ts ELSE first_ts END,
          last_ts = CASE WHEN last_ts IS NULL OR excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`,
        s.id,
        s.title,
        s.project,
        s.cwd,
        s.firstTs,
        s.lastTs,
        s.ccVersion
      );
    },
    upsertRun(r) {
      run(
        `INSERT INTO runs (id, session_id, agent_type, description, launch_tool_use_id, parent_run_id, file)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          agent_type = excluded.agent_type, description = COALESCE(excluded.description, description),
          launch_tool_use_id = COALESCE(excluded.launch_tool_use_id, launch_tool_use_id),
          parent_run_id = COALESCE(excluded.parent_run_id, parent_run_id), file = COALESCE(excluded.file, file)`,
        r.id,
        r.sessionId,
        r.agentType,
        r.description,
        r.launchToolUseId,
        r.parentRunId,
        r.file
      );
    },
    insertPrompt(p) {
      const r = q("INSERT OR IGNORE INTO prompts (uuid, session_id, ts, text, duration_ms) VALUES (?,?,?,?,?)").run(p.uuid, p.sessionId, p.ts, p.text, p.durationMs);
      if (r.changes > 0) return true;
      if (p.durationMs !== null) db.setPromptDuration(p.uuid, p.durationMs);
      return false;
    },
    setPromptDuration(uuid, durationMs) {
      run("UPDATE prompts SET duration_ms = ? WHERE uuid = ?", durationMs, uuid);
    },
    upsertApiCall(c) {
      return db.transaction(() => {
        const t = c.tokens;
        const r = q(`INSERT OR IGNORE INTO api_calls
          (message_id, session_id, run_id, prompt_uuid, ts, model, effort, speed, input, cache_write_5m,
           cache_write_1h, cache_read, output, thinking, ctx_tokens, cost, cost_parts_json, price_id, thinking_ms,
           raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          c.messageId,
          c.sessionId,
          c.runId,
          c.promptUuid,
          c.ts,
          c.model,
          c.effort,
          c.speed,
          t.input,
          t.cacheWrite5m,
          t.cacheWrite1h,
          t.cacheRead,
          t.output,
          t.thinking,
          c.ctxTokens,
          c.cost,
          c.costPartsJson,
          c.priceId,
          c.thinkingMs,
          c.rawJson
        );
        if (r.changes > 0) {
          for (const a of c.advisor) {
            run(
              "INSERT INTO advisor_calls (message_id, model, tokens_json, cost) VALUES (?,?,?,?)",
              c.messageId,
              a.model,
              JSON.stringify(a.tokens),
              a.cost
            );
          }
        }
        for (const u of c.toolUses) {
          insertToolCall({
            toolUseId: u.id,
            messageId: c.messageId,
            runId: c.runId,
            promptUuid: c.promptUuid,
            name: u.name,
            label: u.label,
            skill: u.skill,
            inputJson: u.inputJson,
            startedTs: c.ts
          });
        }
        return r.changes > 0;
      });
    },
    insertToolCall,
    completeToolCall(id, r) {
      const res = q(`UPDATE tool_calls SET ended_ts=?, result_chars=?, is_error=?, denied=?, permission=?
        WHERE tool_use_id=?`).run(r.endedTs, r.resultChars, flag(r.isError), flag(r.denied), r.permission, id);
      if (res.changes > 0) return;
      run(`INSERT OR REPLACE INTO pending_results (tool_use_id, ended_ts, result_chars, is_error, denied, permission)
        VALUES (?,?,?,?,?,?)`, id, r.endedTs, r.resultChars, flag(r.isError), flag(r.denied), r.permission);
    },
    insertCompaction(c) {
      run(
        `INSERT OR IGNORE INTO compactions (session_id, run_id, ts, pre_tokens, duration_ms, trigger) VALUES (?,?,?,?,?,?)`,
        c.sessionId,
        c.runId,
        c.ts,
        c.preTokens,
        c.durationMs,
        c.trigger
      );
    },
    insertHookRuns(sessionId, ts, runs) {
      for (const h of runs) {
        run(
          "INSERT OR IGNORE INTO hook_runs (session_id, ts, command, duration_ms) VALUES (?,?,?,?)",
          sessionId,
          ts,
          h.command,
          h.durationMs
        );
      }
    },
    getFileState(path2) {
      const r = q('SELECT size, mtime_ms, "offset", session_id, run_id, missing FROM files WHERE path = ?').get(path2);
      return r ? {
        size: r.size,
        mtimeMs: r.mtime_ms,
        offset: r.offset,
        sessionId: r.session_id,
        runId: r.run_id,
        missing: r.missing === 1
      } : null;
    },
    setFileState(path2, s) {
      run(
        `INSERT INTO files (path, size, mtime_ms, "offset", session_id, run_id, missing) VALUES (?,?,?,?,?,?,0)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, "offset"=excluded."offset",
          session_id=excluded.session_id, run_id=excluded.run_id, missing=0`,
        path2,
        s.size,
        s.mtimeMs,
        s.offset,
        s.sessionId,
        s.runId
      );
    },
    markFileMissing(path2) {
      run("UPDATE files SET missing = 1 WHERE path = ?", path2);
    },
    presentFiles() {
      return q("SELECT path FROM files WHERE missing = 0").all().map((r) => r.path);
    },
    resolveRunParents() {
      return Number(q(`UPDATE runs SET parent_run_id =
          (SELECT t.run_id FROM tool_calls t WHERE t.tool_use_id = runs.launch_tool_use_id)
        WHERE parent_run_id IS NULL AND launch_tool_use_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.tool_use_id = runs.launch_tool_use_id)`).run().changes);
    },
    meta: {
      delete(key) {
        run("DELETE FROM meta WHERE key = ?", key);
      },
      get(key) {
        const r = q("SELECT value FROM meta WHERE key = ?").get(key);
        return r ? r.value : null;
      },
      set(key, value) {
        run(
          "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          value
        );
      }
    },
    transaction(fn) {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      raw.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth = 0;
      }
    },
    close() {
      raw.close();
    }
  };
  return db;
}

// src/server/server.ts
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json"
};
var CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
var PRESETS = ["today", "week", "month", "all"];
var HEARTBEAT_MS = 25e3;
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
function parseRange(param) {
  const v = param ?? "week";
  if (PRESETS.includes(v)) return { preset: v };
  const parts = v.split(",");
  const ok = (s) => /^\d{4}-\d\d-\d\d/.test(s) && !Number.isNaN(Date.parse(s));
  if (parts.length === 2 && ok(parts[0]) && ok(parts[1])) return { from: parts[0], to: parts[1] };
  throw new HttpError(400, "invalid range");
}
function sameKey(given, key) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookieKey(header) {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === "tt_key") return part.slice(i + 1).trim();
  }
  return void 0;
}
async function startServer(opts = {}) {
  ensureDataHome();
  const root = resolve2(opts.root ?? projectsRoot());
  const uiDir = resolve2(opts.uiDir ?? fileURLToPath(new URL("./ui/", import.meta.url)));
  const idleMs = opts.idleMs ?? 30 * 60 * 1e3;
  const debounceMs = opts.debounceMs ?? 500;
  const key = randomBytes(32).toString("hex");
  const db = openDb(opts.dbPath ?? dbPath());
  const clients = /* @__PURE__ */ new Set();
  let lastActivity = Date.now();
  let port = 0;
  let closed = false;
  function runIndex(waitMs) {
    if (closed) return { indexed: false, changed: [] };
    let changed;
    try {
      const r = withWriteLock(() => indexAll(db, { root }), { waitMs });
      if (r === "busy") return { indexed: false, changed: [] };
      changed = r.changedSessions;
    } catch {
      return { indexed: false, changed: [] };
    }
    if (changed.length) {
      const msg = `data: ${JSON.stringify({ changed })}

`;
      for (const c of clients) c.write(msg);
    }
    return { indexed: true, changed };
  }
  let debounce;
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runIndex(2e3), debounceMs);
  };
  let watcher;
  let poll;
  const startPolling = () => {
    watcher?.close();
    watcher = void 0;
    poll ??= setInterval(schedule, 2e3);
  };
  try {
    watcher = watch(realpathSync.native(root), { recursive: true }, (_ev, name) => {
      if (!name || String(name).endsWith(".jsonl")) schedule();
    });
    watcher.on("error", startPolling);
  } catch {
    startPolling();
  }
  function api(path, q) {
    let seg;
    try {
      seg = path.split("/").slice(2).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "bad path");
    }
    const [name, arg] = seg;
    if (seg.length > 2 || !name) throw new HttpError(404, "not found");
    const found = (v) => {
      if (v == null) throw new HttpError(404, "not found");
      return v;
    };
    const sessionOr404 = (id) => {
      const d = sessionDetail(db, id);
      if (!d.session) throw new HttpError(404, "not found");
      return d;
    };
    const range = () => parseRange(q.get("range"));
    switch (name) {
      case "overview":
        return overview(db, range());
      case "sessions":
        return arg ? sessionOr404(arg) : sessions(db, range());
      case "prompts":
        return arg ? found(promptDetail(db, arg)) : prompts(db, range(), q.get("q") ?? void 0);
      case "agents":
        return arg ? agentDetail(db, arg, range()) : agents(db, range());
      case "coverage":
        return coverage(db);
      default:
        throw new HttpError(404, "not found");
    }
  }
  function send(res, status, body, type, extra = {}) {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP,
      ...extra
    });
    res.end(body);
  }
  const sendJson = (res, status, v) => send(res, status, JSON.stringify(v), "application/json; charset=utf-8");
  function serveStatic(res, pathname, extra) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "bad path");
    }
    if (rel.includes("\0")) throw new HttpError(400, "bad path");
    let file = resolve2(uiDir, "." + (rel.startsWith("/") ? rel : "/" + rel));
    if (file !== uiDir && !file.startsWith(uiDir + sep2)) throw new HttpError(403, "forbidden");
    if (!existsSync5(file) || !statSync3(file).isFile()) file = resolve2(uiDir, "index.html");
    if (!existsSync5(file)) throw new HttpError(404, "ui not built");
    send(res, 200, readFileSync4(file), MIME[extname(file).toLowerCase()] ?? "application/octet-stream", extra);
  }
  function handle(req, res) {
    lastActivity = Date.now();
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "bad host");
    const origin = req.headers.origin;
    if (origin !== void 0 && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      throw new HttpError(403, "bad origin");
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const queryKey = req.method === "GET" && url.pathname === "/" ? url.searchParams.get("key") ?? void 0 : void 0;
    const viaQuery = sameKey(queryKey, key);
    if (!viaQuery && !sameKey(bearer, key) && !sameKey(cookieKey(req.headers.cookie), key)) {
      throw new HttpError(401, "unauthorized");
    }
    const cookie = viaQuery ? { "Set-Cookie": `tt_key=${key}; HttpOnly; SameSite=Strict; Path=/` } : {};
    if (url.pathname === "/api/poke") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const r = runIndex(1e3);
      return sendJson(res, 200, { ok: true, indexed: r.indexed, changed: r.changed });
    }
    if (url.pathname === "/api/events") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff"
      });
      res.write(": connected\n\n");
      clients.add(res);
      const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
      res.on("close", () => {
        clearInterval(beat);
        clients.delete(res);
        lastActivity = Date.now();
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      return sendJson(res, 200, api(url.pathname, url.searchParams));
    }
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    serveStatic(res, url.pathname, cookie);
  }
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message });
        return;
      }
      sendJson(res, 500, { error: "internal error" });
    }
  });
  const serverFile = stateFile("server.json");
  const removeServerFile = () => {
    try {
      const cur = JSON.parse(readFileSync4(serverFile, "utf8"));
      if (cur.pid === process.pid && cur.key === key) rmSync(serverFile, { force: true });
    } catch {
    }
  };
  const onExit = () => removeServerFile();
  const onSignal = () => {
    void close().then(() => {
      opts.onClosed?.();
      process.exit(0);
    });
  };
  let idleTimer;
  let closing;
  function close() {
    closing ??= new Promise((done) => {
      closed = true;
      clearTimeout(debounce);
      clearInterval(idleTimer);
      if (poll) clearInterval(poll);
      watcher?.close();
      process.off("exit", onExit);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      removeServerFile();
      for (const c of clients) c.end();
      clients.clear();
      server.close(() => {
        try {
          db.close();
        } catch {
        }
        done();
      });
      server.closeAllConnections();
    });
    return closing;
  }
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  port = server.address().port;
  writeFileSync(
    serverFile,
    JSON.stringify({ pid: process.pid, port, key, startedAt: (/* @__PURE__ */ new Date()).toISOString() }),
    { mode: 384 }
  );
  process.on("exit", onExit);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  idleTimer = setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActivity >= idleMs) void close().then(() => opts.onClosed?.());
  }, Math.max(20, Math.min(1e3, idleMs / 4)));
  idleTimer.unref();
  setTimeout(() => runIndex(2e3), 0);
  return { url: `http://127.0.0.1:${port}/?key=${key}`, port, key, close };
}
export {
  startServer
};
