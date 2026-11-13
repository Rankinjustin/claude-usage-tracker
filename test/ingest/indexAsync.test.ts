import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { indexAll, indexAllAsync } from '../../src/ingest/indexer';
import { openDb } from '../../src/store/db';

function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'tt-async-'));
  mkdirSync(join(root, 'proj'));
  for (const f of ['agent', 'advisor', 'mcp', 'system', 'tool-results']) {
    copyFileSync(`test/fixtures/${f}.jsonl`, join(root, 'proj', `${f}.jsonl`));
  }
  return root;
}

test('indexAllAsync yields between files', async () => {
  const root = corpus();
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tt-async-db-')), 't.db'));
  let ticked = false;
  setImmediate(() => { ticked = true; });
  let tickedBeforeEnd = false;
  const res = await indexAllAsync(db, { root, onProgress: (done, total) => {
    if (done < total && ticked) tickedBeforeEnd = true;
  } });
  expect(res.files).toBe(5);
  expect(tickedBeforeEnd).toBe(true);
  db.close();
});

test('indexAllAsync produces the same result as indexAll', async () => {
  const root = corpus();
  const mk = () => openDb(join(mkdtempSync(join(tmpdir(), 'tt-async-db-')), 't.db'));
  const a = mk();
  const b = mk();
  const sync = indexAll(a, { root });
  const asyn = await indexAllAsync(b, { root });
  expect({ ...asyn, changedSessions: [...asyn.changedSessions].sort() })
    .toEqual({ ...sync, changedSessions: [...sync.changedSessions].sort() });
  a.close();
  b.close();
});
