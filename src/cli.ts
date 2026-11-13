import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Stub: Task 2 replaces the data-home logic with a proper module.
const sub = process.argv[2] ?? '';
console.log(sub);
try {
  const home = process.env.TOKEN_TRACKER_HOME || join(homedir(), '.claude', 'token-tracker');
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, 'debug.log'), `${new Date().toISOString()} ${sub}\n`);
} catch {
  // Never fail the session.
}
process.exit(0);
