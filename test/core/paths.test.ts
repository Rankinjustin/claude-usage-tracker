import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataHome, dbPath, ensureDataHome, projectsRoot, stateFile } from '../../src/core/paths';

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('paths', () => {
  it('dataHome honours TOKEN_TRACKER_HOME', () => {
    process.env.TOKEN_TRACKER_HOME = join(tmpdir(), 'custom-home');
    expect(dataHome()).toBe(join(tmpdir(), 'custom-home'));
  });

  it('dataHome defaults to <home>/.claude/token-tracker', () => {
    delete process.env.TOKEN_TRACKER_HOME;
    expect(dataHome('/h/u')).toBe(join('/h/u', '.claude', 'token-tracker'));
  });

  it('paths with spaces round-trip', () => {
    delete process.env.TOKEN_TRACKER_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    const home = 'C:\\Users\\Jane Doe';
    const j = process.platform === 'win32' ? win32.join : join;
    expect(dataHome(home)).toBe(j(home, '.claude', 'token-tracker'));
    expect(projectsRoot(home)).toBe(j(home, '.claude', 'projects'));
  });

  it('projectsRoot honours CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'cfg dir');
    expect(projectsRoot()).toBe(join(tmpdir(), 'cfg dir', 'projects'));
  });

  it('dbPath and stateFile live under the data home', () => {
    process.env.TOKEN_TRACKER_HOME = join(tmpdir(), 'h');
    expect(dbPath()).toBe(join(tmpdir(), 'h', 'tracker.db'));
    expect(stateFile('server.json')).toBe(join(tmpdir(), 'h', 'server.json'));
  });

  it.skipIf(process.platform === 'win32')('ensureDataHome creates dir with mode 0o700 on posix', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tt-')), 'nested', 'home');
    process.env.TOKEN_TRACKER_HOME = dir;
    expect(ensureDataHome()).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('ensureDataHome creates the directory and is idempotent', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tt-')), 'home');
    process.env.TOKEN_TRACKER_HOME = dir;
    expect(ensureDataHome()).toBe(dir);
    expect(ensureDataHome()).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
