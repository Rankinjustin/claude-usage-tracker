import { appendFileSync } from 'node:fs';
import { ensureDataHome, stateFile } from './core/paths';

// Stub: later tasks replace this with the real subcommands.
const sub = process.argv[2] ?? '';
console.log(sub);
try {
  ensureDataHome();
  appendFileSync(stateFile('debug.log'), `${new Date().toISOString()} ${sub}\n`);
} catch {
  // Never fail the session.
}
process.exit(0);
