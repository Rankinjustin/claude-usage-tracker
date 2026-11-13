import { appendFileSync } from 'node:fs';
import { ensureDataHome, stateFile } from './paths';

/** Appends a timestamped line to the data home's debug.log; never throws. */
export function log(message: string): void {
  try {
    ensureDataHome();
    appendFileSync(stateFile('debug.log'), `${new Date().toISOString()} ${message}
`);
  } catch {
    // Logging must never fail the session.
  }
}
