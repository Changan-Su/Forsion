/**
 * 常驻引擎(融合插件第 1 档,2026-11-15):插件可以替某个外部引擎(今天只有 DSH)提供一个**已经在跑**的进程,
 * Forsion 的对话改连它,不再每轮起一个新进程。
 *
 * 为什么要这样(方案目录 instrument/evidence/resident-handoff.txt):融合插件常驻一个「网页界面 + 对话入口」同进程的 DSH,
 * 工作台开的是它的网页界面。对话和工作台必须是同一个进程 —— 两个进程开在一份 DSH 目录上会互相挡;而网页界面要接上
 * Forsion 这一场,只有在对话入口**一直开着**这场会话时才行(网页界面自己点开的会话它一直占着,Forsion 再也接不上)。
 *
 * 接缝只管「给一条 ACP 连接」:进程由插件起停、对用户负责;stdout 里不是 JSON 的行(就绪行带着网页界面的启动令牌)
 * 由插件滤掉再交过来 —— 协议库遇到不是 JSON 的行会原样打进日志。
 */
import type { Readable, Writable } from 'node:stream';

export interface ResidentConnection {
  /** 这个进程这一次启动的标识。变了 = 进程重启过,之前开着的会话都不在了。 */
  id: string;
  /** 写给进程的 ACP 消息(它的 stdin)。 */
  input: Writable;
  /** 进程发来的 ACP 消息(它的 stdout,只剩 JSON 行)。 */
  output: Readable;
  /** 进程没了就 resolve。 */
  closed: Promise<void>;
}

/** 宿主对一场常驻会话做了什么(插件据此刷新工作台里开着的那一场)。 */
export interface ResidentSessionEvent {
  /** reopened = 交接内容变了,宿主关掉重接(网页界面里开着这一场的页面要重载才接得上);held = 替工作台接上了。 */
  type: 'reopened' | 'held';
  /** 引擎那边的会话 id。 */
  engineSessionId: string;
  /** Forsion 这边的对话 id(held 时没有)。 */
  sessionId?: string;
}

export interface ResidentEngineHost {
  /** 替哪个引擎(引擎清单里的 id,如 'dsh')。 */
  engineId: string;
  /**
   * 拿到在跑的那个进程。回 null = 这一轮照旧每轮起一个进程,所以**只在进程确实没在跑时**回 null(插件对不上上游新版、被停用、
   * 起不来):两个进程开在同一份引擎目录上会互相挡住同一场会话。
   */
  connect(signal?: AbortSignal): Promise<ResidentConnection | null>;
  /** 可选:宿主关掉重接 / 替工作台接上一场会话时告诉插件。抛错只告警。 */
  onSession?(event: ResidentSessionEvent): void;
}

const hosts = new Map<string, { owner: string; host: ResidentEngineHost }>();
const listeners = new Set<(engineId: string) => void>();

/** 插件登记(经 ctx.registerResidentEngine)。同一个引擎后登记的顶掉先登记的;返回撤销函数(停用插件时宿主调)。 */
export function registerResidentEngineHost(owner: string, host: ResidentEngineHost): () => void {
  if (!host || typeof host.engineId !== 'string' || !host.engineId || typeof host.connect !== 'function') {
    throw new TypeError('registerResidentEngine needs { engineId, connect() }');
  }
  const entry = { owner, host };
  hosts.set(host.engineId, entry);
  for (const l of listeners) l(host.engineId);
  return () => {
    if (hosts.get(host.engineId) !== entry) return;
    hosts.delete(host.engineId);
    for (const l of listeners) l(host.engineId);
  };
}

export function residentHostFor(engineId: string): { owner: string; host: ResidentEngineHost } | undefined {
  return hosts.get(engineId);
}

/** 某个引擎的常驻宿主登记 / 撤销时通知(常驻连接据此收掉旧的)。 */
export function onResidentHostChange(cb: (engineId: string) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 告诉登记这个引擎的插件(没有就算了)。 */
export function notifyResidentHost(engineId: string, event: ResidentSessionEvent): void {
  const reg = hosts.get(engineId);
  if (!reg?.host.onSession) return;
  try { reg.host.onSession(event); } catch (e: any) { console.warn(`[engine:${engineId}] resident host onSession threw: ${e?.message || e}`); }
}
