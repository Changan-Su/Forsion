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
 * 远程请求不许设 / 不许改的 agent_config 键(§4.7 请求字段钳制):
 *   verifyCommand —— 以 /bin/sh -c 在宿主执行且不过审批闸;
 *   engineId / soloEngineId —— 外部 ACP 引擎的工具与进程不经本引擎审批闸与路径策略;
 *   extraRoots —— 免审批可写根;
 *   clientCapabilities / client_capabilities —— 会给 run 注册手机能力,而回执打的是云端;
 *   devices —— 设备挂载(P1),远端不可改。
 */
export const REMOTE_STRIPPED_CONFIG_KEYS = ['verifyCommand', 'engineId', 'soloEngineId', 'extraRoots', 'clientCapabilities', 'client_capabilities', 'devices'] as const;

/** 远程请求带来的 agent_config:剥掉受保护键、审批档钳到上限。返回新对象,不改入参。 */
export function sanitizeRemoteAgentConfig(cfg: Record<string, any>, cap: CapMode = remoteApprovalCap()): Record<string, any> {
  const out: Record<string, any> = { ...cfg };
  for (const k of REMOTE_STRIPPED_CONFIG_KEYS) delete out[k];
  if (typeof out.approvalMode === 'string') out.approvalMode = clampApprovalMode(out.approvalMode, cap);
  return out;
}

/**
 * 远程写会话配置(next = 合并 / 替换之后的整对象):受保护键一律保留存值(远端既设不了、也删不掉 ——
 * PATCH 的 null / PUT 的漏传都算「删」)。审批档:与存值相同 = 没改,原样留(老客户端 PUT 回写整对象不该把本机设的档降掉);
 * 改成别的值 → 钳到上限;改成 custom → 不收(custom 的 allow 规则放行面远端无从判断,本机会话随后的本机 run 会吃到它);
 * 删键(交还缺省)允许。
 */
export function applyRemoteConfigWrite(stored: unknown, next: Record<string, any>, cap: CapMode = remoteApprovalCap()): Record<string, any> {
  const prev = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, any>) : {};
  const has = (o: Record<string, any>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  const out: Record<string, any> = { ...next };
  for (const k of REMOTE_STRIPPED_CONFIG_KEYS) {
    if (has(prev, k)) out[k] = prev[k];
    else delete out[k];
  }
  if (has(out, 'approvalMode') && out.approvalMode !== prev.approvalMode) {
    if (out.approvalMode === 'custom' || typeof out.approvalMode !== 'string') {
      if (has(prev, 'approvalMode')) out.approvalMode = prev.approvalMode;
      else delete out.approvalMode;
    } else {
      out.approvalMode = clampApprovalMode(out.approvalMode, cap);
    }
  }
  return out;
}

// ── 中途染色:远端对一个**本机**起的在飞 run 发 steer,注入的文字从下一个迭代起就在驱动它 → 这条 run 从此按远程钳制。
// 进程内表(run 只活在本进程的 loop 里);runId 唯一,终态后留着也无害,只防无界增长。
const steeredRemote = new Map<string, RemoteInfo>();
const MAX_STEERED = 1000;
export function taintRunRemote(runId: string, info: RemoteInfo): void {
  if (steeredRemote.has(runId)) return;
  if (steeredRemote.size >= MAX_STEERED) steeredRemote.delete(steeredRemote.keys().next().value as string);
  steeredRemote.set(runId, info);
}

/** 本次工具调用 / 审批的有效远程污点:run 起跑时的 input.remote(经 ctx 传下),或之后被远端 steer 染上的。 */
export function effectiveRemote(ctx: { remote?: RemoteInfo; runId?: string } | undefined): RemoteInfo | undefined {
  if (!ctx) return undefined;
  return ctx.remote ?? (ctx.runId ? steeredRemote.get(ctx.runId) : undefined);
}
