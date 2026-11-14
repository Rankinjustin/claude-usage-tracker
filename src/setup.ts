import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

type Settings = Record<string, unknown> & { statusLine?: { type?: string; command?: string } };

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object');
  return parsed as Settings;
}

/** Ours when the command runs this plugin's `statusline` subcommand. */
const isOurs = (s: Settings): boolean => {
  const c = s.statusLine?.command ?? '';
  return c.endsWith('cli.mjs" statusline') && /token-tracker/i.test(c);
};

export function setupCheck(): string {
  const file = settingsPath();
  let s: Settings;
  try { s = readSettings(file); } catch (e) { return `Status line: unknown (${(e as Error).message})`; }
  if (!s.statusLine) return 'Status line: not set';
  return isOurs(s) ? 'Status line: Token Tracker' : `Status line: other (${s.statusLine.command ?? '?'})`;
}

function writeAtomic(file: string, s: Settings): void {
  const tmp = `${file}.tt-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Called on session start: if our status line points at a cli.mjs that no longer exists (plugin updated and
 * the old version removed), rewrite just that command. A referenced cli.mjs that still exists is left alone, so
 * the installed plugin and a dev `--plugin-dir` run don't keep rewriting it to each other. Never creates or
 * touches a statusLine that is not ours. Returns true when it rewrote.
 */
export function repairStatusLine(cliPath: string): boolean {
  const file = settingsPath();
  if (!existsSync(file)) return false;
  const s = readSettings(file);
  const command = `node "${cliPath}" statusline`;
  if (!s.statusLine || !isOurs(s) || s.statusLine.command === command) return false;
  const referenced = /^node "(.+)" statusline$/.exec(s.statusLine.command ?? '')?.[1];
  if (!referenced || existsSync(referenced)) return false;
  s.statusLine = { ...s.statusLine, command };
  writeAtomic(file, s);
  return true;
}

/** Installs the status line; `cliPath` is the absolute path of the running dist/cli.mjs. */
export function setupApply(cliPath: string, replace: boolean): string {
  const file = settingsPath();
  let s: Settings;
  try { s = readSettings(file); } catch (e) {
    return `Not changed: ${file} could not be read as JSON (${(e as Error).message}). Fix or remove it and retry.`;
  }
  const command = `node "${cliPath}" statusline`;
  if (s.statusLine && s.statusLine.command === command) return 'Status line already installed; nothing changed.';
  if (s.statusLine && !isOurs(s) && !replace) {
    return `Not changed: a different status line is already set (${s.statusLine.command ?? '?'}). ` +
      'Run setup --apply --replace to replace it (a backup is kept).';
  }
  mkdirSync(dirname(file), { recursive: true });
  const bak = `${file}.bak-token-tracker`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
  s.statusLine = { type: 'command', command };
  writeAtomic(file, s);
  return `Status line installed in ${file}.`;
}
