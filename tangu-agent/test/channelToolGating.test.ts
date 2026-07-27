/**
 * channel_send_* 门禁(P0-3):仅「hostExec profile + 当前会话连接着通道(ctx.channelSession)」才暴露。
 * 修复前 isEnabledFor 只查 hostExec,未接通道的桌面会话每请求白背 ~1.3KB 定义。
 * registry 级(布尔直断)+ loop 级(真 SQLite 绑定行 → isChannelSession → 最终 payload)。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/registry.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

function names(ctx: ToolContext): string[] {
  return getToolDefinitions(ctx).map((t: any) => t.function?.name);
}

beforeAll(() => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
});

describe('channel_send_* 门禁', () => {
  const base = { userId: 'u1', sessionId: 's1', appId: 'tangu' };
  const profile = createTanguProfile({ sandboxMode: 'none' });

  it('host + 通道会话:暴露', () => {
    const got = names({ ...base, profile, execMode: 'host', cwd: '/tmp', channelSession: true });
    expect(got).toContain('channel_send_file');
    expect(got).toContain('channel_send_image');
  });

  it('host + 非通道会话:不暴露', () => {
    const got = names({ ...base, profile, execMode: 'host', cwd: '/tmp', channelSession: false });
    expect(got).not.toContain('channel_send_file');
    expect(got).not.toContain('channel_send_image');
  });

  it('host + 未传 channelSession(旧调用方兜底):不暴露', () => {
    const got = names({ ...base, profile, execMode: 'host', cwd: '/tmp' });
    expect(got).not.toContain('channel_send_file');
  });
});

describe('loop 级:真 DB 绑定行 → isChannelSession → 最终 payload', () => {
  let home: string;

  async function runOnce(seedBinding: boolean): Promise<{ names: string[]; system: string }> {
    home = mkdtempSync(join(tmpdir(), 'tangu-wcgate-'));
    process.env.TANGU_HOME = home;
    const llmPayloads: any[] = [];
    const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    const fakeBrain: any = {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: o.messages, tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          llmPayloads.push(o.payload);
          return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
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
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
    if (seedBinding) {
      await query(
        `INSERT INTO tangu_wechat_bindings (id, user_id, channel, account_id, session_id, is_active) VALUES ('b1', 'u1', 'wechat', 'acc1', 'S', TRUE)`,
      );
    }
    await createRun({
      id: 'R1', sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: '发个文件', userMessageId: 'U1', attachments: [], agentConfig: { execMode: 'host', cwd: home } },
    });
    enqueueRun('S', 'R1');
    const t0 = Date.now();
    for (;;) {
      const r = await getRun('R1');
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
      if (Date.now() - t0 > 8000) throw new Error('run 未结束');
      await new Promise((res) => setTimeout(res, 25));
    }
    return {
      names: (llmPayloads[0].tools || []).map((t: any) => t.function?.name),
      system: String((llmPayloads[0].messages || []).find((m: any) => m.role === 'system')?.content || ''),
    };
  }

  afterEach(() => {
    delete process.env.TANGU_HOME;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('有活跃绑定:channel_send_* 进 payload,回复风格段=纯文本变体', async () => {
    const got = await runOnce(true);
    expect(got.names).toContain('channel_send_file');
    expect(got.names).toContain('channel_send_image');
    // channelSession → responseStyleSection 纯文本变体(通道端 markdown 会原样露出)
    expect(got.system).toContain('PLAIN TEXT');
    expect(got.system).not.toContain('GitHub-flavored');
    // 引擎级契约段由 agentLoop 直接注入(不经可覆盖的 guidance),最终提示里必在场
    expect(got.system).toContain('## When a Tool Call Fails');
  });

  it('无绑定:channel_send_* 不进 payload,回复风格段=markdown 变体', async () => {
    const got = await runOnce(false);
    expect(got.names).not.toContain('channel_send_file');
    expect(got.system).toContain('GitHub-flavored');
    expect(got.system).not.toContain('PLAIN TEXT');
  });
});
