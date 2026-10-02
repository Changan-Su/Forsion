/**
 * 进程退出前的排空(PI-DSH 评审 R2 收尾):drainRunsForExit 中止在飞 run 并有界等它落完终态 ——
 * 行标 aborted、已完成轮次的部分回答落盘;同会话排在后面的 run 不能被中止触发的推进队列趁退出起跑(留 queued 给下次启动认领)。
 * ⚠️ exiting 是进程级闸、设了不复位:本文件只放这一个用例(vitest 按文件隔离模块)。
 * 真进程版(真 SIGTERM)见 scripts/run-recovery.repro.mjs 的 sigterm 场景。
 */
import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun } from '../src/services/runStore.js';
import { enqueueRun, drainRunsForExit } from '../src/services/agentLoop.js';

it('排空:在飞 run 标 aborted 且部分回答落盘;排队的同会话 run 不起跑', async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-drain-'));
  const USER = 'u1';
  let llmCalls = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
    // 第一轮:一段正文 + 一个无副作用的工具调用(= 已完成的轮次);第二轮一直挂到被中止(= 退出时正在等模型)
    streamProviderCompletion: (o: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        return Promise.resolve({
          content: 'PARTIAL-ANSWER', reasoning: '', finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5 },
          toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
        });
      }
      return new Promise((_, reject) => {
        const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (o.signal?.aborted) fail();
        else o.signal?.addEventListener('abort', fail, { once: true });
      });
    },
  };
  configureTangu({
    host,
    brain: { llm: fakeLlm, users: { getUserById: async () => ({ id: USER, username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  for (const id of ['R1', 'R2']) {
    await createRun({ id, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`, input: { message: 'go', userMessageId: `U-${id}`, attachments: [], agentConfig: {} } });
  }
  enqueueRun('S', 'R1');
  enqueueRun('S', 'R2'); // 排在 R1 后面
  for (let i = 0; i < 200 && llmCalls < 2; i++) await new Promise((r) => setTimeout(r, 10));
  expect(llmCalls).toBe(2);

  await drainRunsForExit(3000);

  const status = async (id: string): Promise<string> => (await query<any[]>(`SELECT status FROM agent_runs WHERE id = ?`, [id]))[0]?.status;
  expect(await status('R1')).toBe('aborted');
  const [msg] = await query<any[]>(`SELECT content FROM chat_messages WHERE id = 'A-R1'`);
  expect(String(msg?.content || '')).toContain('PARTIAL-ANSWER');
  await new Promise((r) => setTimeout(r, 100)); // 给「中止后推进队列」留出起跑的机会:闸住了就不该起
  expect(await status('R2')).toBe('queued');
  expect(llmCalls).toBe(2);
}, 20_000);
