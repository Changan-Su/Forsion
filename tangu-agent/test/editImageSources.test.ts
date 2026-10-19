/**
 * edit_image 的图源接线(改图跨轮取图方案 B1 + B2,2026-10-19):真内存 SQLite + 真 loop。
 *  - B1:本轮没附件时,getImageInputs 回退到 hydrate 正发给模型的那条带图用户消息的原图,并带出那条消息的时刻;
 *    本轮自己有附件时用本轮的、不带时刻。
 *  - B2:listDisplayFiles 能拿到之前 run 已落库的、带 source 标记的产出图。
 * 工具侧的取舍(不收路径 / URL、只认带标记的产出)在 src/tools/builtin/imageEdit.test.ts。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { abortAllRuns, enqueueRun } from '../src/services/agentLoop.js';
import { registerToolProvider } from '../src/tools/toolRegistry.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIxoAAAAASUVORK5CYII=';
const PROBE_CALL = { id: 'c1', type: 'function', function: { name: 'image_source_probe', arguments: '{}' } };
let seen: Array<{ inputs: string[]; sentAt?: number; outputs: string[] }> = [];
let cleanupHome: string | null = null;

afterEach(() => {
  abortAllRuns();
  delete process.env.TANGU_HOME;
  if (cleanupHome) { try { rmSync(cleanupHome, { recursive: true, force: true }); } catch { /* ignore */ } cleanupHome = null; }
});

async function setupLoop(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'tangu-edit-image-sources-'));
  cleanupHome = home;
  process.env.TANGU_HOME = home;
  seen = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  registerToolProvider({
    id: 'test:image-source-probe',
    tools: () => [{
      name: 'image_source_probe', mode: 'both',
      definition: { type: 'function', function: { name: 'image_source_probe', description: 'test only', parameters: { type: 'object', properties: {} } } },
      execute: async (_args: any, ctx: any) => {
        seen.push({
          inputs: (ctx.getImageInputs?.() || []).map((i: any) => i.url),
          sentAt: ctx.getImageInputsSentAt?.(),
          outputs: ((await ctx.listDisplayFiles?.()) || []).filter((f: any) => f.source).map((f: any) => f.name),
        });
        ctx.displayFile?.({ name: `edit-${seen.length}.png`, mime: 'image/png', dataUrl: `data:image/png;base64,${PNG}`, source: 'edit_image' });
        return 'probe ok';
      },
    } as any],
  });
  let turn = 0;
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', context_window: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools }),
    // 每个 run:第一轮调探针,第二轮收尾。
    streamProviderCompletion: async () => {
      const probe = turn++ % 2 === 0;
      return { content: probe ? '' : 'done', reasoning: '', toolCalls: probe ? [PROBE_CALL] : [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: probe ? 'tool_calls' : 'stop' };
    },
  };
  configureTangu({
    host,
    brain: {
      llm: fakeLlm,
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
      memory: { getMemory: async () => ({ content: '' }) },
      models: { hasDirectModel: () => false },
    } as any,
    billing: {
      canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }),
      calculateCost: async () => 0, logApiUsage: async () => {},
    } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
}

async function runToDone(runId: string, attachments: any[] = []): Promise<void> {
  await createRun({
    id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: `hi ${runId}`, userMessageId: `${runId}-u`, attachments, agentConfig: { execMode: 'sandbox' } },
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); return; }
    if (Date.now() - t0 > 15_000) throw new Error(`run ${runId} 未结束`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

const attachment = { name: 'face.png', mimeType: 'image/png', data: PNG };

describe('edit_image 图源接线', () => {
  it('本轮没附件 → 用上一条带图消息的图并带出它的时刻;之前 run 的产出能按标记查到', async () => {
    await setupLoop();
    await runToDone('R1', [attachment]);
    expect(seen[0]).toEqual({ inputs: [`data:image/png;base64,${PNG}`], sentAt: undefined, outputs: [] });

    await runToDone('R2');
    const sentAt = Number((await query<any[]>(`SELECT timestamp FROM chat_messages WHERE id = 'R1-u'`))[0].timestamp);
    expect(seen[1].inputs).toEqual([`data:image/png;base64,${PNG}`]);
    expect(seen[1].sentAt).toBe(sentAt);
    expect(seen[1].outputs).toEqual(['edit-1.png']); // R1 的产出已落库,R2 查得到
  });

  it('没有任何带图消息时什么也不回退', async () => {
    await setupLoop();
    await runToDone('R1');
    expect(seen[0]).toEqual({ inputs: [], sentAt: undefined, outputs: [] });
  });
});
