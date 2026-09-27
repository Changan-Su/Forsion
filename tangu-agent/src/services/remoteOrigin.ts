/**
 * 远程来源(设备能力 MCP 方案 P0 ④,契约 C1 / C3):经 unitWeb 隧道 / P2P / 局域网进来的引擎请求。
 *
 * C1:桌面 unitWeb 代理 /engine/* 时先剥掉入站的 `x-forsion-remote*`,再盖 `x-forsion-remote: tunnel|p2p|lan`
 * 与 `x-forsion-remote-mark: <每次启动的密钥>`(主进程生成,经 env TANGU_REMOTE_MARK_SECRET 交给引擎)。
 * 引擎只要看到 `x-forsion-remote` 就按**远程**处理 —— 标记只会收紧、不会放宽;mark 只用于记录
 * `input.remote.marked`(本机其他进程自己加头 = 未盖章的远程,照样被钳),**绝不**据它信任任何调用方身份(callerUnit 是 P1 的事)。
 *
 * 引擎只认 `run.input.remote`(本模块经路由解析、派生 run 显式抄写);请求体 / 会话存值里的任何同名字段一律不作数。
 *
 * C3:远程污点 run 的**有效**审批档 = min(档, config.json `remote.maxApprovalMode`),序 readonly < auto-edit < full-auto,
 * 缺省 auto-edit。设置界面在 P1。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { getRawSection } from '../core/config.js';
import { remoteCwdForbidden } from '../sandbox/hostSandboxProtection.js';

export type RemoteVia = 'tunnel' | 'p2p' | 'lan';
export interface RemoteInfo {
  /** 来源入口;头值不在契约内(只可能是本机进程自己加的头)→ undefined,但仍按远程处理(fail-closed)。 */
  via?: RemoteVia;
  /** true = 带着本次启动的 unitWeb 密钥盖章;false = 没盖章 / 盖错。只作记录,不放宽任何东西。 */
  marked: boolean;
}

export type CapMode = 'readonly' | 'auto-edit' | 'full-auto';
const VIAS = new Set<RemoteVia>(['tunnel', 'p2p', 'lan']);
const RANK: Record<CapMode, number> = { readonly: 0, 'auto-edit': 1, 'full-auto': 2 };

type HeaderBag = Record<string, string | string[] | undefined>;
const headerOf = (headers: HeaderBag | undefined, name: string): string | undefined => {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};

/** sha256 两侧再比:timingSafeEqual 对不等长直接抛,且长度本身不该漏。 */
function markMatches(given: string | undefined): boolean {
  const secret = process.env.TANGU_REMOTE_MARK_SECRET;
  if (!secret || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** 从请求头解析远程来源;无 `x-forsion-remote` → undefined(本机请求)。 */
export function parseRemoteOrigin(headers: HeaderBag | undefined): RemoteInfo | undefined {
  const raw = headerOf(headers, 'x-forsion-remote');
  if (raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase();
  return {
    ...(VIAS.has(v as RemoteVia) ? { via: v as RemoteVia } : {}),
    marked: markMatches(headerOf(headers, 'x-forsion-remote-mark')),
  };
}

/** run.input.remote → RemoteInfo(只认对象形状;来自库里,字段按契约重建,不透传多余键)。 */
export function remoteOf(input: any): RemoteInfo | undefined {
  const r = input?.remote;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  return { ...(VIAS.has(r.via) ? { via: r.via as RemoteVia } : {}), marked: r.marked === true };
}

/** config.json `remote.maxApprovalMode`(每次现读,改完下一次工具调用即生效);非法 / 缺省 → auto-edit。 */
export function remoteApprovalCap(): CapMode {
  const v = (getRawSection('remote') as any)?.maxApprovalMode;
  return v === 'readonly' || v === 'full-auto' || v === 'auto-edit' ? v : 'auto-edit';
}

/** 档位取小。'custom' 原样返回(规则层的钳制在审批闸里做);未设 → cap(未设在闸里等于免审批)。 */
export function clampApprovalMode(mode: string | undefined, cap: CapMode): CapMode | 'custom' {
  if (mode === 'custom') return mode;
  if (mode === 'readonly' || mode === 'auto-edit' || mode === 'full-auto') return RANK[mode] <= RANK[cap] ? mode : cap;
  return cap;
}

/**
 * 远程**起 run**(POST /agent/runs、TODO 注入照抄的会话配置)不许带的 agent_config 键(§4.7 请求字段钳制,契约 C1 + C7):
 *   verifyCommand —— 以 /bin/sh -c 在宿主执行且不过审批闸;
 *   engineId / soloEngineId —— 外部 ACP 引擎的工具与进程不经本引擎审批闸与路径策略;
 *   extraRoots —— 免审批可写根;
 *   clientCapabilities / client_capabilities —— 会给 run 注册手机能力,而回执打的是云端;
 *   devices —— 设备挂载(P1),远端不可改;
 *   remoteOrigin —— 会话的远程标记(路由侧盖),远端既不能伪造也不能抹掉;
 *   muse / activityAccess / automationOrigin / approvalDeferral —— 引擎内部角色键:muse 让 run 看见 add_muse_todo / set_next_wake /
 *     read_activity,TODO 被批准后排出的 Muse run **不带污点**(Muse 自动档是完全通行)= 远端借 Muse 起一条无钳制的后续执行;
 *     其余几个改的是「有没有人在看、审批往哪排」;
 *   delegatedFrom / delegatedBy / subAgentGrants —— 委派身份与授予(子代理管理工具的开口);
 *   systemPrompt / soul —— 人格替换;toolsMode / toolsList —— 工具黑白名单(本机 Agent 定义的东西)。
 * 这是**起 run** 的剥离名单(请求里其余键是这一轮的正常参数:execMode / preset / cwd / planMode …;cwd 另由 C8 校验)。
 * 会话配置的远程**写**走白名单,见 REMOTE_WRITABLE_CONFIG_KEYS。
 */
export const REMOTE_STRIPPED_CONFIG_KEYS = [
  'verifyCommand', 'engineId', 'soloEngineId', 'extraRoots', 'clientCapabilities', 'client_capabilities', 'devices', 'remoteOrigin',
  'muse', 'activityAccess', 'automationOrigin', 'approvalDeferral', 'delegatedFrom', 'delegatedBy', 'subAgentGrants',
  'systemPrompt', 'soul', 'toolsMode', 'toolsList',
] as const;

/**
 * 契约 C7:远程**写会话配置**(PUT|PATCH /agent/sessions/:id/config、远程 POST /agent/sessions 的初始配置)只收这些键;
 * 其余一律保留存值 —— 存值是本机下一次 run 会照抄的东西,远端改不了、也删不掉。白名单而不是黑名单:明天新加的配置键缺省就远端不可写。
 *   agentSlug —— 选 Agent(其定义的审批档经激活时再钳,C3);
 *   modelId / model —— 模型;thinkingLevel / ultra / effort / reasoningEffort —— 思考档一类;
 *   title / name —— 标题一类;
 *   approvalMode —— 钳到上限(C3),custom 不收(见 applyRemoteConfigWrite)。
 * ⚠️ 远端新建的会话因此只存这几个键(execMode / preset / cwd 等不落库):远端那一轮不受影响(run 用请求里的 agent_config),
 * 只是本机日后打开这个会话时看到的是缺省值。与桌面 unitWeb 路由表(engineRoutes.generated.ts)那条注释同一口径。
 */
export const REMOTE_WRITABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'agentSlug', 'modelId', 'model', 'thinkingLevel', 'ultra', 'effort', 'reasoningEffort', 'title', 'name', 'approvalMode',
]);

/** 远程请求带来的 agent_config(起 run 用):剥掉受保护键、审批档钳到上限。返回新对象,不改入参。cwd 不在这里动 —— 由路由按 C8 校验、拒整条请求。 */
export function sanitizeRemoteAgentConfig(cfg: Record<string, any>, cap: CapMode = remoteApprovalCap()): Record<string, any> {
  const out: Record<string, any> = { ...cfg };
  for (const k of REMOTE_STRIPPED_CONFIG_KEYS) delete out[k];
  if (typeof out.approvalMode === 'string') out.approvalMode = clampApprovalMode(out.approvalMode, cap);
  return out;
}

/** 契约 C8 的错误码:远程请求的 cwd / project_path 落在根 / 家目录 / 受保护目录(或其祖先)。路由回 400 `{ code, detail }`。 */
export const REMOTE_CWD_FORBIDDEN = 'REMOTE_CWD_FORBIDDEN';
/** 远程请求带来的这些路径里有没有 C8 禁用的(空值 / 非字符串不算 —— 没带就是没设)。 */
export function remoteCwdViolation(...paths: unknown[]): string | null {
  for (const p of paths) if (typeof p === 'string' && p.trim() && remoteCwdForbidden(p.trim())) return p.trim();
  return null;
}
export function remoteCwdErrorBody(p: string): { code: string; detail: string } {
  return {
    code: REMOTE_CWD_FORBIDDEN,
    detail: `A remote session cannot use ${p} as its working directory (the filesystem root, the home folder, and folders that contain protected configuration are not allowed). Pick a project folder instead.`,
  };
}

/** 契约 C9:远端(x-forsion-remote)答审批 / 询问 / 异步审批时夹带 argsOverride → 400。改参数 = 远端改写本机随后要执行的东西
 *  (与设备审批 §6.1 同理,那边 body 只许三值)。「总允许」的降级在审批兑现路由里做(approve_always → approve)。 */
export const REMOTE_ARGS_OVERRIDE_FORBIDDEN = 'REMOTE_ARGS_OVERRIDE_FORBIDDEN';
export function remoteArgsOverrideRejected(headers: Record<string, string | string[] | undefined> | undefined, body: any): boolean {
  return !!parseRemoteOrigin(headers) && body?.argsOverride != null;
}
export const remoteArgsOverrideBody = {
  code: REMOTE_ARGS_OVERRIDE_FORBIDDEN,
  detail: 'Editing the arguments of an approval is only available on the host computer. Approve or reject it as is.',
};

/**
 * 远程写会话配置(next = 合并 / 替换之后的整对象;契约 C7):只有白名单键取 next 的值,其余键一律保留存值
 * (远端既设不了、也删不掉 —— PATCH 的 null / PUT 的漏传都算「删」)。
 * 审批档(P0 第三轮 E1)**只许收紧**:存值是本机随后的 run 现读的档(gateToolCall 的 modeSessionId),远端把它放宽 = 远端替本机
 * 放宽审批面(与桌面 lastApprovalMode 对远程只读同一口径)。
 *   · 存值是 custom → 永不改写、永不删除(custom 的 deny / ask 规则是用户写死的约束,换成三档之一它们就不再生效);
 *   · 删键(PATCH null / PUT 漏传)→ 保留存值,永不删键;
 *   · 改成三档之一 → 只收 rank(next) ≤ rank(基线) 的(readonly < auto-edit < full-auto),再钳到上限;更宽的原样丢掉。
 *     基线 = 存值;既有会话没有存值 → 基线按 readonly(本机那一侧的缺省来自各端自己的记忆档,远端看不到,只收最严的);
 *   · 改成 custom → 不收。
 * 新建会话(opts.create:远程 POST /agent/sessions,没有本机存值可放宽)→ 照旧钳到上限。
 * ⚠️ 结果:远端建会话时没带审批档,日后设备页也只能把它设成 readonly;要更宽的档得在本机改。
 */
export function applyRemoteConfigWrite(stored: unknown, next: Record<string, any>, cap: CapMode = remoteApprovalCap(), opts: { create?: boolean } = {}): Record<string, any> {
  const prev = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, any>) : {};
  const has = (o: Record<string, any>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  const out: Record<string, any> = {};
  for (const k of Object.keys(prev)) if (!REMOTE_WRITABLE_CONFIG_KEYS.has(k)) out[k] = prev[k];
  for (const k of REMOTE_WRITABLE_CONFIG_KEYS) if (k !== 'approvalMode' && has(next, k)) out[k] = next[k];
  const want = next.approvalMode;
  const three = (v: unknown): v is CapMode => v === 'readonly' || v === 'auto-edit' || v === 'full-auto';
  let mode: unknown = prev.approvalMode;
  if (opts.create) {
    if (three(want)) mode = clampApprovalMode(want, cap);
  } else if (prev.approvalMode !== 'custom' && three(want) && want !== prev.approvalMode) {
    const baseline: CapMode = three(prev.approvalMode) ? prev.approvalMode : 'readonly';
    if (RANK[want] <= RANK[baseline]) mode = clampApprovalMode(want, cap);
  }
  if (mode !== undefined) out.approvalMode = mode;
  return out;
}

// ── P0 第三轮 E5 / E6:远程污点 run 不许动的持久化管理面。────────────────────────────────────────
/** Agent 定义 / 技能 / 自动化规则 / 日程:它们在下一次**本机** run(或到点无人值守、强制 full-auto 的自动化 run)里生效,
 *  远端借一条 run 改它们 = 把自己的指令种进本机。只放行 list;其余动作(create / update / delete / set / remove,以及明天新加的动作)
 *  一律硬拒 —— 不进审批:按 D1 远端能批自己的卡,弹卡挡不住。审批闸与工具实现两处共用这一个判定。 */
const REMOTE_READONLY_MANAGEMENT = new Set(['manage_agent', 'manage_skill', 'manage_automation', 'manage_schedule']);
export function remoteManagementDenied(tool: string, action: unknown): string | null {
  if (!REMOTE_READONLY_MANAGEMENT.has(tool) || action === 'list') return null;
  return `Remote sessions cannot create, change or delete agents, skills, automations or schedules (${tool} action "${String(action ?? '')}"): they take effect in later runs on the host computer. Only action "list" is available here; ask the user to make this change on the host computer.`;
}

// ── 中途染色:远端对一个**本机**起的在飞 run 发 steer,注入的文字从下一个迭代起就在驱动它 → 这条 run 从此按远程钳制。
// 进程内表(run 只活在本进程的 loop 里)。只登记**已成功入队**的 steer(路由里 enqueueSteer 成功之后才调),
// 表项随 run 收尾由 agentLoop 清掉(clearRunRemoteTaint)—— 表长 ≤ 在飞 run 数,不做容量淘汰:
// 按 FIFO 挤掉的若是仍在跑的 run,它就悄悄回到本机档位(Codex 评审)。
const steeredRemote = new Map<string, RemoteInfo>();
export function taintRunRemote(runId: string, info: RemoteInfo): void {
  if (!steeredRemote.has(runId)) steeredRemote.set(runId, info);
}
export function clearRunRemoteTaint(runId: string): void {
  steeredRemote.delete(runId);
}

/** 本次工具调用 / 审批的有效远程污点:run 起跑时的 input.remote(经 ctx 传下),或之后被远端 steer 染上的。 */
export function effectiveRemote(ctx: { remote?: RemoteInfo; runId?: string } | undefined): RemoteInfo | undefined {
  if (!ctx) return undefined;
  return ctx.remote ?? (ctx.runId ? steeredRemote.get(ctx.runId) : undefined);
}
