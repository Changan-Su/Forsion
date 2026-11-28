import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { pinAmadeusVault } from '../core/amadeusVault.js';
import { createTanguProfile } from '../profiles/index.js';
import { configureTangu } from '../seams/runtime.js';
import { currentRunAmadeusVault, enterRunContext, setRunAmadeusVault } from '../seams/runContext.js';
import { loadCursors } from './dbCursors.js';
import { __museTickForTests } from './muse.js';
import { saveTriggers, type MuseTrigger } from './museTriggers.js';

const activity = vi.hoisted(() => ({ beforeRead: undefined as (() => void) | undefined }));
vi.mock('./userActivity.js', async (original) => ({
  ...await original<typeof import('./userActivity.js')>(),
  readActivityLines: async () => {
    activity.beforeRead?.();
    activity.beforeRead = undefined;
    return [];
  },
}));

let home: string;
let config: string;
let first: string;
let second: string;
let closeDb: () => void;

const row = (id: string, value: string) => ({ id, cells: { value } });
function seed(root: string, path: string, rows: ReturnType<typeof row>[]) {
  writeFileSync(join(root, path), JSON.stringify({ version: 1, name: 'Table', columns: [{ id: 'value', name: 'Value', type: 'text' }], rows }));
}
function rows(root: string, path: string): ReturnType<typeof row>[] {
  return JSON.parse(readFileSync(join(root, path), 'utf8')).rows;
}
function select(root: string) {
  writeFileSync(config, JSON.stringify({ lastVault: root }));
}
function rule(id: string, root: string, actions: NonNullable<MuseTrigger['actions']>): MuseTrigger {
  return {
    id, enabled: true, desc: 'Update table', cooldownHours: 0, lastFiredAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    cond: { type: 'db_changed', path: 'Source.db', vault: root, event: 'row_added' },
    actions,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'muse-vault-pin-'));
  vi.stubEnv('TANGU_HOME', home);
  vi.stubEnv('FORSION_AMADEUS_VAULT', undefined);
  vi.stubEnv('FORSION_REMOTE_LOCK_FILE', undefined);
  config = join(home, 'amadeus-config.json');
  vi.stubEnv('FORSION_AMADEUS_CONFIG', config);
  first = join(home, 'first');
  second = join(home, 'second');
  for (const root of [first, second]) {
    mkdirSync(root);
    seed(root, 'Source.db', [row('initial', 'baseline')]);
    seed(root, 'Target.db', [row('target', 'original')]);
  }
  writeFileSync(join(home, 'special-agents.json'), JSON.stringify({ muse: { enabled: false } }));
  activity.beforeRead = undefined;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'local' });
  closeDb = () => db.close();
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none' }), brain: {} as never, billing: {} as never });
  await runMigration();
});

afterEach(() => {
  enterRunContext('');
  closeDb?.();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it('review P0-4: a tick uses the same vault for evaluation, actions and cursors after a switch', async () => {
  select(first);
  await saveTriggers([rule('first-rule', first, [
    { type: 'db_row_edit', path: 'Target.db', rowId: 'target', cells: { Value: '{{row.Value}}' } },
    { type: 'db_row_add', path: 'Source.db', cells: { Value: 'self write' } },
  ])]);
  await __museTickForTests();
  seed(first, 'Source.db', [row('initial', 'baseline'), row('user-row', 'change from first')]);
  activity.beforeRead = () => select(second);

  await __museTickForTests();

  expect(rows(first, 'Target.db')).toEqual([row('target', 'change from first')]);
  expect(rows(second, 'Target.db')).toEqual([row('target', 'original')]);
  const sourceRows = rows(first, 'Source.db');
  expect(sourceRows.map(entry => entry.cells.value)).toEqual(['baseline', 'change from first', 'self write']);
  expect((await loadCursors())['first-rule']).toMatchObject({ vault: first, rowIds: sourceRows.map(entry => entry.id) });
});

it('review P1-8: a tick launched by an ended run timer reads the new vault', async () => {
  select(second);
  await saveTriggers([rule('second-rule', second, [
    { type: 'db_row_edit', path: 'Target.db', rowId: 'target', cells: { Value: '{{row.Value}}' } },
  ])]);
  await __museTickForTests();
  select(first);
  enterRunContext('local', 'finished-run');
  setRunAmadeusVault(pinAmadeusVault('finished-run'));
  select(second);
  seed(second, 'Source.db', [row('initial', 'baseline'), row('user-row', 'change from second')]);

  await new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      try {
        expect(currentRunAmadeusVault()).toMatchObject({ kind: 'local', root: first });
        __museTickForTests().then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }, 0);
  });

  expect(rows(second, 'Target.db')).toEqual([row('target', 'change from second')]);
  expect(rows(first, 'Target.db')).toEqual([row('target', 'original')]);
});
