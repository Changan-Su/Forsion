import { expect, it } from 'vitest';
import { createSqliteHost } from '../../adapters/standalone/sqliteHost.js';
import { configureTangu, deps } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';
import { toSqliteDDL } from '../../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../../db/schemaStandalone.js';
import { createSqlStateStore } from './sqlStateStore.js';

it('persisted image receipts survive a new store and are scoped to the account across sessions', async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 't', userId: 'owner' });
  try {
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    await deps().state.autoCreateSession({ id: 's1', userId: 'owner', appId: 'tangu', title: 'old', modelId: 'm' });
    const receipt = { id: 'job1', receipt: 'hash1' };
    expect(await deps().state.hasImageDelivery!('owner', 's1', receipt)).toBe(false);
    await deps().state.finalizeAssistantMessage({ messageId: 'm1', sessionId: 's1', modelId: 'm', content: '', reasoning: '', toolCalls: [], toolResults: [],
      displayFiles: [{ name: 'image.gif', dataUrl: 'data:image/gif;base64,R0lGODlh', imageDelivery: receipt }] });
    const restarted = createSqlStateStore();
    expect(await restarted.hasImageDelivery!('owner', 'new-session', receipt)).toBe(true);
    expect(await restarted.hasImageDelivery!('another-account', 's1', receipt)).toBe(false);
    expect(await restarted.hasImageDelivery!('owner', 's1', { ...receipt, receipt: 'wrong' })).toBe(false);
  } finally { db.close(); }
});
