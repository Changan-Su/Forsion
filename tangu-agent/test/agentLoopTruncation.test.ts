/**
 * 主 loop 截断硬化测试(P0-1,借 pi failToolCallsFromTruncatedMessage):
 * finish_reason=length 且带 tool_calls → 一个不执行、全部置错回喂,模型下一轮收到错误结果后正常收尾。
 * 仪器:真内存 SQLite + 真 runStore/eventBus + 真 loop(startRun),fake llm 两轮脚本(首轮截断、次轮收尾)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
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
import { enqueueRun } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
let llmPayloads: any[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-trunc-'));
  process.env.TANGU_HOME = home;
  llmPayloads = [];

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
    streamProviderCompletion: async (o: any) => {
      llmPayloads.push(o.payload);
      if (llmPayloads.length === 1) {
        // 首轮:被 max_tokens 截断的响应——参数是「能解析但不完整」的半截 JSON 已被流式补救成合法对象
        return {
          content: '',
          reasoning: '',
          toolCalls: [
            { id: 't1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"半截内容"}' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
          finishReason: 'length',
        };
      }
      return { content: '收尾完成', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
    },
  };
  const fakeBrain: any = {
    llm: fakeLlm,
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`,
    [USER],
  );
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function waitRunSettled(runId: string, ms = 8000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > ms) throw new Error(`run 未在 ${ms}ms 内结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe('finish_reason=length 截断硬化', () => {
  it('截断轮的工具调用不执行、置错回喂;下一轮正常收尾', async () => {
    await createRun({
      id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: '写个文件', userMessageId: 'U1', attachments: [], agentConfig: {} },
    });
    enqueueRun('S', 'R1');
    const run = await waitRunSettled('R1');

    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2);

    // 第二轮 LLM 收到的上下文里:assistant 带原 tool_calls + role:tool 的置错结果(未执行)
    const msgs2 = llmPayloads[1].messages as any[];
    const toolIdx = msgs2.findIndex((m) => m.role === 'tool' && m.tool_call_id === 't1');
    expect(toolIdx, '截断的工具调用必须以错误结果回喂').toBeGreaterThan(0);
    const toolMsg = msgs2[toolIdx];
    expect(String(toolMsg.content)).toContain('NOT executed');
    expect(String(toolMsg.content)).toContain('token limit');
    // 协议配对完整:tool 结果紧跟带同 id tool_calls 的 assistant
    expect(msgs2[toolIdx - 1].role).toBe('assistant');
    expect(JSON.stringify(msgs2[toolIdx - 1].tool_calls || [])).toContain('t1');
    // 工具确实未执行:全 home 下不存在 a.txt(若守卫失效,sandbox 'none' 会真写出来)
    expect(execSync(`find "${home}" -name a.txt`).toString().trim()).toBe('');

    // 最终助手消息:第二轮的收尾文本落库
    const rows = await query<any[]>(`SELECT content, tool_results FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
    expect(rows.length).toBe(1);
    expect(String(rows[0].content)).toContain('收尾完成');
    const persisted = typeof rows[0].tool_results === 'string' ? rows[0].tool_results : JSON.stringify(rows[0].tool_results);
    expect(persisted).toContain('NOT executed');
  });
});
