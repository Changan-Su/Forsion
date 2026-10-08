/**
 * 主模型看不到图 → Computer Use 不可用,并让模型把原因告诉用户(10-08 用户定)· 真 loop
 * (内存 SQLite + 真 agentLoop + 脚本化 fake llm + 一个声明了 concurrencyKey:'computer-use' 的假工具组)。
 *
 *   ① 主模型没有图像输入(自动档):那组工具不在主模型的工具面里;系统提示里有那句原因(不是插件没开 / 换成有图像输入的模型);
 *      识别模型配没配都一样。 ①b 「图像识别」设成「总是」:同样不给,但原因说的是那个设置(Codex 10-08)。
 *   ② 主模型凭名字去调 / 去 load_tools 那组工具 → 回的是同一句原因,不是「不可用,可能是插件设置或权限」。
 *   ③ 不受影响的:主模型能看图;这一 run 里本来就没有那组工具(插件停用)—— 工具面与系统提示都和改动前一样。
 *   ④ 子代理(delegate)也拿不到那组工具(它没有自己的图像通道,放给它等于留一条盲操作的后门)。
 *   ⑤ 「看不看得到图」的判定卡住:最多等 2 秒就照旧起跑,这一 run 不收工具。
 * 负对照(实跑过):去掉 toolRegistry.resolveTools 里收起那一行 → ① ①b ② ④ 红;
 *   去掉 registry.executeTool 里回原因那一段 → ② 红。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
import { subscribe } from '../src/services/eventBus.js';
import { resolveApproval } from '../src/services/approvals.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { registerToolProvider, unregisterToolProvider, computerUseUnavailableReason } from '../src/tools/toolRegistry.js';
import { __resetVisionSlotCacheForTests } from '../src/services/visionService.js';

const USER = 'u1';
const CU = { sideEffect: 'read' as const, parallel: false, concurrencyKey: 'computer-use' };

let cuOn = true;
let observed = 0;
const fakeTool = (name: string, execute: () => string) => ({
  name, mode: 'host' as const, isEnabledFor: () => cuOn, capabilities: CU,
  definition: { type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } },
  execute: async () => execute(),
});
beforeAll(() => registerToolProvider({
  id: 'plugin:fake-cu', origin: 'plugin',
  tools: () => [fakeTool('fake_observe', () => { observed++; return 'observed'; }), fakeTool('fake_click', () => 'clicked')],
}));
afterAll(() => { unregisterToolProvider('plugin:fake-cu'); });

let home: string;
let ws: string;
let script: Array<() => any>;
/** 每次流式模型请求(主 loop 与子代理共用同一个脚本队列,按到达顺序消费)。 */
let requests: Array<{ tools: string[]; messages: any[] }>;
let stallCatalog: boolean;
/** 模型目录里标成「没有图像输入」的模型(自动档靠它判)。 */
let noVisionModels: string[];

const call = (name: string, args: Record<string, unknown> = {}) => () => ({
  content: '', reasoning: '', toolCalls: [{ id: `c-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
});
const final = (text = 'ok') => () => ({ content: text, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-cunv-'));
  process.env.TANGU_HOME = home;
  ws = mkdtempSync(join(tmpdir(), 'tangu-cunv-ws-'));
  script = []; requests = []; cuOn = true; observed = 0; stallCatalog = false; noVisionModels = [];
  __resetVisionSlotCacheForTests();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async (id: string) => ({ model: { provider: 'test', name: id }, apiKey: 'k', baseUrl: 'b', apiModelId: id }),
      buildProviderPayload: async (o: any) => ({ tools: (o.tools || []).map((t: any) => t.function.name), messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return final('bg')(); // 标题 / 记忆等后台请求
        requests.push({ tools: o.payload.tools, messages: o.payload.messages });
        return (script.shift() ?? final('script exhausted'))();
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false, listModelsForProject: () => (stallCatalog ? new Promise(() => {}) : Promise.resolve({ models: noVisionModels.map((id) => ({ id, supportsVision: false })), visionModelId: null })) },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'main-m', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});

let runSeq = 0;
async function run(agentConfig: Record<string, any>): Promise<string> {
  const runId = `N${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'main-m', assistantMessageId: `${runId}-a`,
    input: { message: 'open the chat app and read the last message', userMessageId: `${runId}-u`, agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'full-auto', ...agentConfig }, origin: 'client' },
  });
  const off = subscribe(runId, (ev) => { if (ev.type === 'approval_request') resolveApproval(ev.payload.approvalId, { action: 'approve' }); });
  enqueueRun('S', runId);
  const t0 = Date.now();
  try {
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return String(r.status);
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally { off(); }
}

const BLIND = { visionMode: 'always' }; // 「图像识别」设成「总是」:主模型收不到原图
const NO_INPUT = computerUseUnavailableReason('no-image-input');
const ALWAYS = computerUseUnavailableReason('always-transcribe');
const systemOf = (r: { messages: any[] }) => r.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
const lastToolResult = () => String(requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').at(-1).content);

describe('主模型看不到图 → Computer Use 不可用,并把原因告诉用户', () => {
  it('① 主模型没有图像输入(自动档):那组工具不在工具面里;系统提示写明原因与出路;识别模型配没配都一样', async () => {
    noVisionModels = ['main-m'];
    script = [final('done')];
    expect(await run({})).toBe('done');
    expect(requests[0].tools).not.toContain('fake_observe');
    expect(requests[0].tools).not.toContain('fake_click');
    const sys = systemOf(requests[0]);
    expect(sys).toContain(NO_INPUT);
    expect(NO_INPUT).toMatch(/with the current model because it has no image input/);
    expect(NO_INPUT).toMatch(/do not just report that the tools are missing/);
    expect(NO_INPUT).toMatch(/switch this chat to a model with image input/);
    expect(NO_INPUT).toMatch(/not a missing plugin or permission/);
    expect(sys).toContain('not in your tool list: fake_observe, fake_click.');
    // 配了识别模型也一样(它只负责把别的图转成文字,不替主模型操作电脑)
    requests = []; script = [final('done')];
    await run({ visionModelId: 'vision-m' });
    expect(requests[0].tools).not.toContain('fake_observe');
    expect(systemOf(requests[0])).toContain(NO_INPUT);
  });

  it('①b 「图像识别」设成「总是」:同样不给工具,但原因说的是那个设置,不说「这个模型没有图像输入」', async () => {
    script = [final('done')];
    expect(await run(BLIND)).toBe('done');
    expect(requests[0].tools).not.toContain('fake_observe');
    const sys = systemOf(requests[0]);
    expect(sys).toContain(ALWAYS);
    expect(sys).not.toContain('because it has no image input');
    // 设置名 / 选项名照抄桌面设置页实际显示的字(AuxModelChoice 的 aux.visionBehavior / aux.visionCompact.*):用户要照着去找。
    expect(ALWAYS).toMatch(/"Image handling" in Settings is on "Always", that they need to change it to "When needed", and that switching models will not help/);
    // 「总是」不看模型:换模型不是出路,这句里不能把它当成二选一给出去。
    expect(ALWAYS).not.toMatch(/or switch this chat to a model/);
    expect(ALWAYS).toMatch(/图像处理方式.*始终使用.*按需使用/);
    expect(ALWAYS).not.toMatch(/"Auto"/);
  });

  it('② 凭名字去调 / 去 load_tools 那组工具:回的是同一句原因,工具没有执行', async () => {
    noVisionModels = ['main-m'];
    script = [call('fake_observe'), call('load_tools', { names: ['fake_observe', 'fake_click', 'no_such_tool'] }), final('done')];
    expect(await run({})).toBe('done');
    const toolMsgs = requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]).toBe(`Tool "fake_observe" was not run. ${NO_INPUT}`);
    expect(observed).toBe(0);
    expect(toolMsgs[1]).toContain(`Not loadable: fake_observe, fake_click. ${NO_INPUT}`);
    expect(toolMsgs[1]).toMatch(/Unavailable in this session: no_such_tool\./); // 真不存在的照旧报不可用,被收起的不并进这一句
  });

  it('③ 不受影响:主模型能看图;这一 run 里本来就没有那组工具', async () => {
    script = [call('fake_observe'), final('done')];
    expect(await run({ visionMode: 'off' })).toBe('done');
    expect(requests[0].tools).toContain('fake_observe');
    expect(systemOf(requests[0])).not.toContain('Computer control is unavailable');
    expect(lastToolResult()).toBe('observed');
    // 看不到图,但插件停用:没有东西可收,系统提示里也不该多那一段
    requests = []; script = [final('done')]; cuOn = false;
    await run(BLIND);
    expect(requests[0].tools).not.toContain('fake_observe');
    expect(systemOf(requests[0])).not.toContain('Computer control is unavailable');
  });

  it('④ 子代理(delegate)同样拿不到那组工具', async () => {
    script = [call('delegate', { task: 'look at the screen' }), final('sub done'), final('done')];
    expect(await run(BLIND)).toBe('done');
    expect(requests).toHaveLength(3);
    expect(requests[1].tools).not.toContain('fake_observe');
    expect(requests[1].tools).not.toContain('fake_click');
  });

  it('⑤ 判定卡住:最多等 2 秒就照旧起跑,这一 run 不收工具', async () => {
    stallCatalog = true;
    script = [final('done')];
    const t0 = Date.now();
    expect(await run({})).toBe('done'); // auto 档 → 要问模型目录,而它永远不回
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(requests[0].tools).toContain('fake_observe');
    expect(systemOf(requests[0])).not.toContain('Computer control is unavailable');
  });
});
