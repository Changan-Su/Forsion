/**
 * 引擎管理器（仅 standalone/desktop 组装；deps().engines 可选——microserver/worker 不构造，云端零影响，
 * 对齐 mcp/manager.ts 的可选注入法）。spike：一 run 一进程（runAcpEngine 内 spawn，turn 结束即 kill），
 * 无全局进程池可 dispose。
 */
import type { ToolCall } from '../core/types.js';
import type { ApprovalDecision } from '../services/approvals.js';
import { loadEngines, isEngineAvailable, loadEnginePrefs, saveEngineDefaultModel, type EngineDef } from './config.js';
import { runAcpEngine, probeAcpEngine } from './acpEngine.js';

/** externalEngineLoop 传入：一次外部引擎 turn 所需的上下文 + 回灌接缝。 */
export interface EngineRunCtx {
  engineId: string;
  runId: string;
  sessionId: string;
  userId: string;
  modelId?: string;
  /** 用户为外部引擎选的模型(经 ACP unstable_setSessionModel 应用);空=用引擎默认。 */
  engineModelId?: string;
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
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: any[];
  stopReason?: string;
}

/** 引擎能力(懒探测得到):可选模型 + 当前模型 + slash 命令。 */
export interface EngineCapabilities {
  models: Array<{ id: string; name: string; description?: string }>;
  currentModelId?: string;
  commands: Array<{ name: string; description: string; hint?: string }>;
}

/** 列表项:含快速检测的 available + 每引擎默认模型(prefs)。 */
export interface EngineListItem {
  id: string;
  name: string;
  available: boolean;
  defaultModel?: string;
}

export interface EngineManager {
  /** 给 GET /agent/engines 与 UI 选择器(含 available/defaultModel)。 */
  list(): EngineListItem[];
  has(id: string): boolean;
  /** 懒探测引擎能力(spawn 一次拿 models/commands)并缓存。 */
  capabilities(id: string): Promise<EngineCapabilities>;
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
  let prefs = loadEnginePrefs();
  return {
    list: () => engines.map((e) => ({ id: e.id, name: e.name, available: isEngineAvailable(e), defaultModel: prefs[e.id]?.defaultModel })),
    has: (id) => byId.has(id),
    capabilities: async (id) => {
      const def = byId.get(id);
      if (!def) throw new Error(`unknown engine: ${id}`);
      // 静态声明优先(配了就不探测)。
      if (def.models || def.commands) {
        return { models: def.models ?? [], commands: def.commands ?? [], currentModelId: undefined };
      }
      const hit = capsCache.get(id);
      if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.caps;
      const caps = await probeAcpEngine(def);
      capsCache.set(id, { caps, at: Date.now() });
      return caps;
    },
    setDefaultModel: (id, modelId) => {
      saveEngineDefaultModel(id, modelId);
      prefs = loadEnginePrefs();
    },
    run: (ctx) => {
      const def = byId.get(ctx.engineId);
      if (!def) throw new Error(`unknown engine: ${ctx.engineId}`);
      // 用户未在本会话选模型 → 回退该引擎的默认模型偏好(设置页「Agent CLIs」配置)。
      const engineModelId = ctx.engineModelId || prefs[ctx.engineId]?.defaultModel;
      return runAcpEngine(def, { ...ctx, engineModelId });
    },
    dispose: async () => {
      /* 一 run 一进程，无全局资源 */
    },
  };
}
