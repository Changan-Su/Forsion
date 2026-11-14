/**
 * 引擎管理器（仅 standalone/desktop 组装；deps().engines 可选——microserver/worker 不构造，云端零影响，
 * 对齐 mcp/manager.ts 的可选注入法）。spike：一 run 一进程（runAcpEngine 内 spawn，turn 结束即 kill），
 * 无全局进程池可 dispose。
 */
import type { ToolCall } from '../core/types.js';
import type { ApprovalDecision } from '../services/approvals.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadEngines, engineStatus, loadEnginePrefs, saveEngineDefaultModel, saveEngineProbeSession, type EngineDef, type EngineStatus } from './config.js';
import { tanguHome } from '../core/tanguHome.js';
import { runAcpEngine, probeAcpEngine } from './acpEngine.js';
import { isHostSandboxRestricted } from '../sandbox/hostSandboxPolicy.js';

/** externalEngineLoop 传入：一次外部引擎 turn 所需的上下文 + 回灌接缝。 */
export interface EngineRunCtx {
  engineId: string;
  runId: string;
  sessionId: string;
  userId: string;
  modelId?: string;
  /** 用户为外部引擎选的模型(经 ACP unstable_setSessionModel 应用);空=用引擎默认。 */
  engineModelId?: string;
  resumeSessionId?: string;
  /** 上一行:要续接的引擎会话。续不上一律失败(不悄悄新开);那个会话在引擎那边已经没有了时,抛出的错误带 externalSessionGone。 */
  /** 普通对话的续接才传:那个引擎会话是哪家适配器记下的(握手里报的名字;null = 老指针没记)。握手之后核对 ——
   *  名字对不上(同一个引擎 id 在 engines.json 里被改指到了别的命令),或者当前这家的普通对话续接没核过,就不拿旧会话 id 去问它,
   *  直接新开一个会话(等于引擎换了)。插件任务不传(undefined),照旧按 resumeSessionId 续接。 */
  resumeFromAgent?: string | null;
  /** 引擎会话一建立(新建或续上)就回调,在 prompt 之前。resumable = 这个引擎下一轮接得上它;
   *  via = 下一轮会怎么接:'load'(session/load,回放历史)/ 'resume'(session/resume,不回放)。
   *  verifiedForChat = 普通对话里下一轮可以接着用它:走 resume 的都算,走 load 的只算用真引擎核过的适配器
   *  (名单见 acpEngine.ts 的 LOAD_RESUME_VERIFIED)。插件任务不看这一项,照旧按 resumable 续接。
   *  agent = 握手里报的适配器名(普通对话把它和指针记在一起,见 resumeFromAgent)。 */
  onSession?: (info: { id: string; resumable: boolean; resumed: boolean; via?: 'load' | 'resume'; verifiedForChat?: boolean; agent?: string }) => void | Promise<void>;
  readOnly?: boolean;
  mcpServers?: import('@agentclientprotocol/sdk').McpServer[];
  message: string;
  attachments?: any[];
  cwd?: string;
  signal: AbortSignal;
  /** 把翻译后的事件回灌 Tangu eventBus（token/reasoning/tool_call/tool_result/usage/status）。 */
  publish: (type: string, payload: any) => void;
  /** 复用 Tangu 审批：发 approval_request 事件并 await 用户决定。 */
  requestApproval: (preview: string, toolCall: ToolCall) => Promise<ApprovalDecision>;
}

export interface EngineResult {
  tokensTotal?: number;
  externalSessionId?: string;
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: any[];
  stopReason?: string;
}

/** 引擎能力(懒探测得到):可选模型 + 当前模型 + slash 命令。 */
export interface EngineCapabilities {
  loadSession?: boolean;
  /** 引擎报了 sessionCapabilities.resume(续接但不回放,DSH)。 */
  resume?: boolean;
  /** 思考档(ACP configOptions 里 category = thought_level 的那一项)。只读出来,本引擎目前不改它。 */
  thoughtLevels?: Array<{ id: string; name: string; description?: string }>;
  currentThoughtLevel?: string;
  modes?: Array<{id: string; name: string}>;
  models: Array<{ id: string; name: string; description?: string }>;
  currentModelId?: string;
  commands: Array<{ name: string; description: string; hint?: string }>;
}

/** 列表项:含快速检测的 available/status + 每引擎默认模型(prefs)。 */
export interface EngineListItem {
  id: string;
  name: string;
  /** 严格「可直接用」= status==='available'(已登录);needs-signin 时为 false,故新建会话选择器不列它。 */
  available: boolean;
  /** 三态:available / needs-signin / not-installed(设置页据此显示「需登录」等)。 */
  status: EngineStatus;
  defaultModel?: string;
  /** 未检测到时给用户看的一行安装命令(见 EngineDef.setup)。 */
  setup?: string;
}

export interface EngineManager {
  /** 给 GET /agent/engines 与 UI 选择器(含 available/defaultModel)。 */
  list(): EngineListItem[];
  has(id: string): boolean;
  /** 懒探测引擎能力(spawn 一次拿 models/commands)并缓存。fresh = 不用缓存、重新探测(引擎那边的模型清单变了:登录了、填了 key)。 */
  capabilities(id: string, opts?: { fresh?: boolean }): Promise<EngineCapabilities>;
  /** 设某引擎默认模型(持久化到 ~/.tangu/engine-prefs.json;空串=清除)。 */
  setDefaultModel(id: string, modelId: string): void;
  run(ctx: EngineRunCtx): Promise<EngineResult>;
  dispose(): Promise<void>;
}

const CAPS_TTL_MS = 10 * 60 * 1000; // 软 TTL:能力变动慢,缓存 10 分钟;进程重启即清

export function createEngineManager(configFile?: string): EngineManager {
  const engines = loadEngines(configFile);
  const byId = new Map<string, EngineDef>(engines.map((e) => [e.id, e]));
  const capsCache = new Map<string, { caps: EngineCapabilities; at: number }>();
  // 同一个引擎正在跑的那次探测:缓存没命中时两处同时来问(两个窗口各开一次模型下拉)要合成一次。分开跑的话第二个
  // 续不上探测会话(被第一个占着),会另建一个并顶掉记着的那个 —— 每撞一次就在引擎的历史里多留一个空会话。
  // 每个引擎的探测要附上它开始时的「代」:缓存作废一次(fresh 探测、或当前模型缺 API key 的失败)代就加一。旧代的探测
  // 可能是在用户登录之前开始的,它的结果不进缓存,也不拿来回答新来的问 —— 不然作废之后马上又被旧清单填回去。
  const probing = new Map<string, { gen: number; task: Promise<EngineCapabilities> }>();
  const gen = new Map<string, number>();
  const invalidate = (id: string): void => { gen.set(id, (gen.get(id) ?? 0) + 1); capsCache.delete(id); };
  let prefs = loadEnginePrefs();
  return {
    list: () => engines.map((e) => {
      const status = engineStatus(e);
      return { id: e.id, name: e.name, available: status === 'available', status, defaultModel: prefs[e.id]?.defaultModel, setup: e.setup };
    }),
    has: (id) => byId.has(id),
    capabilities: async (id, opts) => {
      if (isHostSandboxRestricted()) throw new Error('External engine probing is unavailable while the local sandbox is enabled');
      const def = byId.get(id);
      if (!def) throw new Error(`unknown engine: ${id}`);
      // 静态声明优先(配了就不探测)。
      if (def.models || def.commands) {
        return { models: def.models ?? [], commands: def.commands ?? [], currentModelId: undefined };
      }
      if (opts?.fresh) invalidate(id);
      const myGen = gen.get(id) ?? 0;
      const hit = capsCache.get(id);
      if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.caps;
      const running = probing.get(id);
      if (running && running.gen === myGen) return running.task;
      // 正在跑的是旧代的:等它跑完再探(两个探测同时跑会抢同一个探测会话,见上面 probing 的说明),它的结果不要
      const before = running?.task.catch(() => undefined);
      const task: Promise<EngineCapabilities> = (async () => {
        await before;
        // 探测会话的固定工作目录(只有复用探测会话的引擎用得上,见 probeAcpEngine):本引擎自己的目录,不落在用户的项目里。
        const probeDir = path.join(tanguHome(), 'engines', id, 'probe');
        try { mkdirSync(probeDir, { recursive: true }); } catch { /* 建不出来就让引擎自己报错 */ }
        const { probeSessionId, ...caps } = await probeAcpEngine(def, { reuseSessionId: prefs[id]?.probeSessionId, reuseCwd: probeDir });
        if (probeSessionId && probeSessionId !== prefs[id]?.probeSessionId) {
          saveEngineProbeSession(id, probeSessionId);
          prefs = loadEnginePrefs();
        }
        if ((gen.get(id) ?? 0) === myGen) capsCache.set(id, { caps, at: Date.now() });
        return caps;
      })().finally(() => { if (probing.get(id)?.task === task) probing.delete(id); });
      probing.set(id, { gen: myGen, task });
      return task;
    },
    setDefaultModel: (id, modelId) => {
      saveEngineDefaultModel(id, modelId);
      prefs = loadEnginePrefs();
    },
    run: async (ctx) => {
      ctx.signal.throwIfAborted();
      if (isHostSandboxRestricted()) throw new Error('External engines are unavailable while the local sandbox is enabled');
      const def = byId.get(ctx.engineId);
      if (!def) throw new Error(`unknown engine: ${ctx.engineId}`);
      // 用户未在本会话选模型 → 回退该引擎的默认模型偏好(设置页「Agent CLIs」配置)。
      const engineModelId = ctx.engineModelId || prefs[ctx.engineId]?.defaultModel;
      try {
        return await runAcpEngine(def, { ...ctx, engineModelId });
      } catch (e: any) {
        // 「当前模型缺 API key」的提示叫用户去模型下拉里换一个:缓存着的清单这时作废,下次问能力清单重新探测 ——
        // 用户照提示去引擎那边登录 / 填了 key 之后,新出现的模型才选得到(不然要等缓存过期)。
        if (e?.engineModelNoApiKey) invalidate(ctx.engineId);
        throw e;
      }
    },
    dispose: async () => {
      /* 一 run 一进程，无全局资源 */
    },
  };
}
