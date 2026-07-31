/**
 * deferred tools 按需装载(P0-2,借 pi deferred-tools):
 * registry 级——defer 工具默认不进 defs、load_tools 只在「有未解锁项且调用方支持」时出现、
 *   解锁后追加在内置 defs 末尾、muse/automation 全量、deferGroup 连坐、部署白名单自动补 load_tools;
 * loop 级——模型调 load_tools 后下一迭代 tools 里出现解锁工具;真实 delegate 子代理拿精简集且不污染父。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions, listDeferredTools, executeTool } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/registry.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const profile = createTanguProfile({ sandboxMode: 'none' });

function names(ctx: ToolContext): string[] {
  return getToolDefinitions(ctx).map((t: any) => t.function?.name);
}

// ── loop 级共用 harness:真内存 SQLite + 真 loop,fake llm 按调用序号出剧本 ──
type LlmScript = (call: number) => { content: string; toolCalls: any[]; finishReason: string };
async function setupLoop(script: LlmScript): Promise<{ home: string; llmPayloads: any[] }> {
  const home = mkdtempSync(join(tmpdir(), 'tangu-defer-'));
  process.env.TANGU_HOME = home;
  const llmPayloads: any[] = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => {
      llmPayloads.push(o.payload);
      const s = script(llmPayloads.length);
      return { content: s.content, reasoning: '', toolCalls: s.toolCalls, usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: s.finishReason };
    },
  };
  const fakeBrain: any = {
    llm: fakeLlm,
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
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
  return { home, llmPayloads };
}

async function runToDone(runId = 'R1', message = 'hi'): Promise<void> {
  await createRun({
    id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message, userMessageId: `${runId}-u`, attachments: [], agentConfig: {} },
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) {
      expect(r.status).toBe('done');
      return;
    }
    if (Date.now() - t0 > 8000) throw new Error('run 未结束');
    await new Promise((res) => setTimeout(res, 25));
  }
}

let cleanupHome: string | null = null;
afterEach(() => {
  delete process.env.TANGU_HOME;
  if (cleanupHome) { try { rmSync(cleanupHome, { recursive: true, force: true }); } catch { /* ignore */ } cleanupHome = null; }
});

describe('registry 级:defer 过滤与解锁', () => {
  const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' };

  it('默认:deferred 不进 defs,load_tools 进;目录含 defer 项', () => {
    configureTangu({ host: stub, brain: stub, billing: stub, profile });
    const got = names({ ...base, unlockTools: () => {} });
    expect(got).toContain('load_tools');
    for (const n of ['manage_automation', 'manage_schedule', 'manage_agent', 'manage_skill', 'start_discussion', 'wait_discussion', 'generate_image', 'calculator']) {
      expect(got, `${n} 应被 defer`).not.toContain(n);
    }
    const catalog = listDeferredTools(base).map((d) => d.name);
    expect(catalog).toContain('manage_automation');
    expect(catalog).toContain('calculator');
  });

  it('解锁后:追加在内置 defs 末尾;未提供 unlockTools 的调用方两者皆无', () => {
    const got = names({ ...base, unlockTools: () => {}, unlockedTools: new Set(['manage_automation']) });
    expect(got[got.length - 1]).toBe('manage_automation'); // 末尾追加,immediate 前缀字节不动
    const lean = names({ ...base }); // 无 unlockTools
    expect(lean).not.toContain('load_tools');
    expect(lean).not.toContain('manage_automation');
  });

  it('muse / automation 系统 run:全量可见,load_tools 不出现', () => {
    const got = names({ ...base, muse: true, unlockTools: () => {} });
    expect(got).toContain('manage_automation');
    expect(got).not.toContain('load_tools');
    const auto = names({ ...base, automationOrigin: 'rule-1', unlockTools: () => {} });
    expect(auto).toContain('manage_automation');
  });

  it('load_tools 执行:deferGroup 连坐解锁 discussion 对;未知名报告', async () => {
    const unlocked: string[] = [];
    const ctx: ToolContext = { ...base, unlockTools: (ns) => unlocked.push(...ns) };
    const r = await executeTool(
      { id: 'c1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: ['start_discussion', 'nope_tool'] }) } } as any,
      ctx,
    );
    expect(unlocked).toContain('start_discussion');
    expect(unlocked).toContain('wait_discussion'); // 同组连坐
    expect(String(r.result)).toContain('start_discussion');
    expect(String(r.result)).toContain('nope_tool');
  });

  it('部署白名单含 deferred 却漏列 load_tools:自动补上,不留死锁;无 deferred 项则不强塞', () => {
    const curated = createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['get_datetime', 'read_file', 'calculator'] });
    const got = names({ ...base, profile: curated, unlockTools: () => {} });
    expect(got).toContain('load_tools');
    expect(got).not.toContain('calculator'); // 仍 defer,经 load_tools 可达
    expect(listDeferredTools({ ...base, profile: curated }).map((d) => d.name)).toContain('calculator');
    const plain = createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['get_datetime', 'read_file'] });
    expect(names({ ...base, profile: plain, unlockTools: () => {} })).not.toContain('load_tools');
  });
});

describe('registry 级:preset=coding 产品面工具转 deferred(WB-Bench 收敛)', () => {
  const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', preset: 'coding' };

  it('coding:浏览器/笔记/web/记忆面离场,核心编码面常驻,load_tools 可解锁', () => {
    configureTangu({ host: stub, brain: stub, billing: stub, profile });
    const got = names({ ...base, unlockTools: () => {} });
    for (const n of ['browser_search', 'browser_navigate', 'browser_snapshot', 'web_search', 'web_fetch',
      'amadeus_list_notes', 'amadeus_create_event', 'inbox_send', 'display_file', 'read_session',
      'remember', 'log_event', 'read_log', 'read_document']) {
      expect(got, `${n} 应被 coding 预设 defer`).not.toContain(n);
    }
    for (const n of ['run_bash', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'apply_patch',
      'list_dir', 'search_files', 'glob_files', 'todo_write', 'run_background', 'delegate', 'ask_user']) {
      expect(got, `${n} 是编码核心面`).toContain(n);
    }
    expect(got).toContain('load_tools');
    // 目录仍列全量可解锁项(可发现性);解锁后回到 defs
    const catalog = listDeferredTools(base).map((d) => d.name);
    expect(catalog).toContain('web_fetch');
    expect(catalog).toContain('browser_search');
    const unlocked = names({ ...base, unlockTools: () => {}, unlockedTools: new Set(['web_fetch']) });
    expect(unlocked).toContain('web_fetch');
  });

  it('无 preset:行为零变化(web/browser/amadeus 常驻)', () => {
    configureTangu({ host: stub, brain: stub, billing: stub, profile });
    const got = names({ userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', unlockTools: () => {} });
    for (const n of ['browser_search', 'web_fetch', 'amadeus_list_notes', 'log_event', 'remember']) {
      expect(got, `${n} 非 coding 预设应常驻`).toContain(n);
    }
  });
});

describe('loop 级:load_tools 解锁 → 下一迭代 defs 含解锁工具', () => {
  it('首轮无 manage_automation 有 load_tools;解锁后第二轮 tools 含 manage_automation', async () => {
    const { home, llmPayloads } = await setupLoop((call) => {
      if (call === 1) {
        return { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'load_tools', arguments: '{"names":["manage_automation"]}' } }], finishReason: 'tool_calls' };
      }
      return { content: '好了', toolCalls: [], finishReason: 'stop' };
    });
    cleanupHome = home;
    await runToDone('R1', '给我设个提醒');

    expect(llmPayloads.length).toBe(2);
    const names1 = (llmPayloads[0].tools || []).map((t: any) => t.function?.name);
    const names2 = (llmPayloads[1].tools || []).map((t: any) => t.function?.name);
    expect(names1).toContain('load_tools');
    expect(names1).not.toContain('manage_automation');
    expect(names2).toContain('manage_automation'); // 解锁生效
    expect(names2[names2.length - 1]).toBe('manage_automation'); // 末尾追加
    const sys = (llmPayloads[0].messages as any[]).find((m) => m.role === 'system');
    expect(String(sys?.content)).toContain('Additional Tools (load on demand)');
    expect(String(sys?.content)).toContain('manage_automation');
  });

  it('真实 delegate 子代理:拿精简集(无 load_tools/deferred/delegate),父 run 解锁面不被污染', async () => {
    const { home, llmPayloads } = await setupLoop((call) => {
      if (call === 1) {
        return { content: '', toolCalls: [{ id: 'd1', type: 'function', function: { name: 'delegate', arguments: '{"task":"analyze the numbers and report"}' } }], finishReason: 'tool_calls' };
      }
      if (call === 2) return { content: '子代理完成', toolCalls: [], finishReason: 'stop' }; // 子代理唯一一轮
      return { content: '汇总完毕', toolCalls: [], finishReason: 'stop' };
    });
    cleanupHome = home;
    await runToDone('R2', '委派个任务');

    expect(llmPayloads.length).toBe(3);
    const subNames = (llmPayloads[1].tools || []).map((t: any) => t.function?.name);
    expect(subNames.length).toBeGreaterThan(0);
    expect(subNames).not.toContain('load_tools'); // 剥掉 unlockTools → 不可解锁
    expect(subNames).not.toContain('manage_automation'); // deferred 隐藏
    expect(subNames).not.toContain('delegate'); // 深度防递归
    // 父 run 第二轮(汇总轮)defs 不被子代理污染:仍无 deferred、仍有 load_tools
    const mainNames = (llmPayloads[2].tools || []).map((t: any) => t.function?.name);
    expect(mainNames).toContain('load_tools');
    expect(mainNames).not.toContain('manage_automation');
  });
});
