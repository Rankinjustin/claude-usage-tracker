import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Data home: TOKEN_TRACKER_HOME, else <home>/.claude/token-tracker. `home` is a test seam. */
export function dataHome(home: string = homedir()): string {
  return process.env.TOKEN_TRACKER_HOME || join(home, '.claude', 'token-tracker');
}

/** Transcripts root: CLAUDE_CONFIG_DIR/projects, else <home>/.claude/projects. */
export function projectsRoot(home: string = homedir()): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  return join(base, 'projects');
}

export function dbPath(): string {
  return join(dataHome(), 'tracker.db');
}

export function stateFile(name: 'server.json' | 'installed.json' | 'debug.log'): string {
  return join(dataHome(), name);
}

/** Restricts a Windows directory to the current user. Best effort; never throws. */
function restrictWindows(dir: string): void {
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { stdio: 'ignore' });
  } catch {
    // ACL tooling missing or failing must not break the session.
  }
}

/** Creates the data home owner-only (once) and returns its path. */
export function ensureDataHome(): string {
  const dir = dataHome();
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed && process.platform === 'win32') restrictWindows(dir);
  return dir;
}
