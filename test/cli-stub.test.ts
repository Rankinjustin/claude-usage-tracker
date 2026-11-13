import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('cli stub prints the subcommand and logs it', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-'));
  const out = execFileSync('node', ['dist/cli.mjs', 'open'], {
    env: { ...process.env, TOKEN_TRACKER_HOME: home },
    encoding: 'utf8',
  });
  expect(out.trim()).toBe('open');
  expect(readFileSync(join(home, 'debug.log'), 'utf8')).toMatch(/Z open\n$/);
});
