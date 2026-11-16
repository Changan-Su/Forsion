/** 导入会话的首份摘要(checkpointImportedHistory,11-16):真 SQLite + 真 compactSession,摘要模型桩记录每次喂进去的转写。
 *  钉住 Codex 第二轮 #1:几百条老行要分段压,每段都进摘要输入、检查点逐段推进 —— 而不是一次塞满、最早那截被
 *  buildTranscript 从头丢掉却照样标成已覆盖。也钉住按停(signal)后不再往下压。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { importConversations } from './sessionImport.js';
import { checkpointImportedHistory } from './agentLoop.js';
import { getLatestSummary } from './compaction.js';
import { DEFAULT_COMPACTION_SETTINGS } from './compactionSettings.js';

let inputs: string[] = [];
let onSummary: (() => void) | null = null;
beforeEach(async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-import-ckpt-'));
  inputs = []; onSummary = null;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: [] }),
    brain: {
      llm: {
        // 摘要模型窗口故意给小(32k):一次塞 400 条长消息必然超预算
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 32_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          inputs.push(o.payload.messages.map((m: any) => String(m.content)).join('\n'));
          onSummary?.();
          return { content: `summary #${inputs.length}`, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
});

const T0 = Date.UTC(2026, 0, 1);
async function seed(n: number, size = 600): Promise<string> {
  const messages = Array.from({ length: n }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: `${i === 0 ? 'UNIQUE-OPENING-FACT ' : ''}line ${i} ` + 'x'.repeat(size),
    timestamp: T0 + i * 1000,
  }));
  const [r] = await importConversations({ userId: 'u1', appId: 'tangu', source: 'deepseek', modelId: 'm1', projectless: true, agentConfig: { preset: 'chat' }, conversations: [{ external_id: 'big', messages }] });
  if (r.status !== 'created') throw new Error(JSON.stringify(r));
  return r.session_id;
}

describe('checkpointImportedHistory', () => {
  it('summarizes old rows in several passes, so the opening reaches the summarizer and the checkpoint ends at the window', async () => {
    const sid = await seed(400);
    await checkpointImportedHistory(sid, 'm1', 'tangu', { ...DEFAULT_COMPACTION_SETTINGS, enabled: true }, 'medium');
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs[0]).toContain('UNIQUE-OPENING-FACT');
    expect(inputs.some((t) => t.includes('earlier entries omitted'))).toBe(false);
    const ck = await getLatestSummary(sid);
    // 窗口按 n+1 = 401 算:起点 360,窗口外最后一行是第 359 条
    expect(ck?.throughTimestamp).toBe(T0 + 359 * 1000);
    // 再来一次:已覆盖,不再调摘要
    const before = inputs.length;
    await checkpointImportedHistory(sid, 'm1', 'tangu', { ...DEFAULT_COMPACTION_SETTINGS, enabled: true }, 'medium');
    expect(inputs.length).toBe(before);
  });

  it('long messages that would each fill a pass still get summarized (no single-row passes stopping the whole thing)', async () => {
    const sid = await seed(120, 14_000);
    await checkpointImportedHistory(sid, 'm1', 'tangu', { ...DEFAULT_COMPACTION_SETTINGS, enabled: true }, 'medium');
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs[0]).toContain('UNIQUE-OPENING-FACT');
    // 窗口按 n+1 = 121 算:起点 80,窗口外最后一行是第 79 条
    expect((await getLatestSummary(sid))?.throughTimestamp).toBe(T0 + 79 * 1000);
  });

  it('stops after the current pass once the run is stopped', async () => {
    const sid = await seed(400);
    const ac = new AbortController();
    onSummary = () => ac.abort();
    await expect(checkpointImportedHistory(sid, 'm1', 'tangu', { ...DEFAULT_COMPACTION_SETTINGS, enabled: true }, 'medium', ac.signal)).rejects.toThrow();
    expect(inputs.length).toBe(1);
  });

  it('short imports (inside the window) need no summary', async () => {
    const sid = await seed(30);
    await checkpointImportedHistory(sid, 'm1', 'tangu', { ...DEFAULT_COMPACTION_SETTINGS, enabled: true }, 'medium');
    expect(inputs.length).toBe(0);
  });
});
