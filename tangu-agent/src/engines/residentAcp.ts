/**
 * 连一个常驻的外部引擎进程(融合插件第 1 档;接缝见 residentHosts.ts)跑一轮。和 acpEngine.runAcpEngine 的区别:
 *
 *  - 一个进程一条 ACP 连接(它的 stdio 只有一份),多场对话共用:引擎发来的通知按 sessionId 分给正在跑那一轮的客户端;
 *    没有 Forsion 的轮在跑的(工作台里发的那一轮)不上屏。审批(审批 B):插件那边只把 Forsion 发的轮的审批交到这条连接上,
 *    照常进这一轮的审批卡;万一没有 Forsion 的轮在等还来问,回「取消」并记日志(工作台的审批不该到这里)。
 *    引擎的扩展通知 `_forsion/notice`(「DSH 在工作台里等你批准」)也按 sessionId 交给那一轮,没人在等就不上屏。
 *  - 一轮结束**不关会话、不杀进程**:会话一直开着,工作台(DSH 自己的网页界面,同一个进程)才能接上同一个活的会话;
 *    对话入口一关,工作台那边就变成「会话不可用」,而工作台自己点开的会话它一直占着、Forsion 再也接不上(实测,
 *    方案目录 instrument/evidence/resident-handoff.txt)。
 *  - 交给引擎的人设 / 记忆 / 技能目录不走进程环境变量(常驻进程只有一份环境),走每场会话自己那座桥的 `instructions`
 *    (bridgeRelay.ts)。说明只在连上时读一次,所以交接的内容(key)变了才关掉会话、换一座新桥续接。
 *  - 停掉一轮只发 cancel,不杀进程。
 */
import { Writable, Readable } from 'node:stream';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tanguHome } from '../core/tanguHome.js';
import path from 'node:path';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type InitializeResponse } from '@agentclientprotocol/sdk';
import type { EngineDef } from './config.js';
import type { EngineCapabilities, EngineRunCtx, EngineResult } from './manager.js';
import {
  acpErrorText, applyEngineModel, chatResumeVerified, classifyResumeFailure, createAcpClient, HANDSHAKE_TIMEOUT_MS,
  mapAcpCommands, mapAcpConfigOptions, mapAcpModels, missingApiKeyRoute, modelNoApiKeyError, withTimeout, type AcpClientCtx, type AcpConfigSelection,
} from './acpEngine.js';
import { notifyResidentHost, onResidentHostChange, residentHostFor, type ResidentConnection } from './residentHosts.js';
import { createBridgeRelay, type BridgeRelay } from './bridgeRelay.js';

/** 常驻进程上最多同时开着多少场 Forsion 的会话;超了关最久没用的(没在跑的)。 */
const MAX_OPEN_SESSIONS = Number(process.env.TANGU_RESIDENT_MAX_SESSIONS) || 24;
/** 停掉 / 看门狗到点发了 cancel 之后,等引擎收住这一轮的上限;到点还没收住就关掉这场会话(下一句重开),这一轮按停止收尾。 */
const CANCEL_GRACE_MS = Number(process.env.TANGU_RESIDENT_CANCEL_GRACE_MS) || 15_000;
const stoppedError = (msg = 'Stopped'): Error => Object.assign(new Error(msg), { name: 'AbortError' });

interface OpenSession {
  id: string;
  cwd: string;
  /** 交接内容的指纹(说明 + 交过去的工具);变了要关掉重接,说明才换得掉。 */
  key: string;
  relay: BridgeRelay | null;
  /** 正在跑这一场的那一轮的客户端;null = 没有 Forsion 的轮在跑。 */
  route: Client | null;
  /** 上次回包里的模型清单(会话本来就开着、这一轮没有回包时用来换模型)。 */
  sel?: AcpConfigSelection;
  lastUsed: number;
}

/** 这一轮常驻进程要的交接:桥上带的说明 + 指纹。不交接(普通引擎对话)不传。 */
export interface ResidentHandoff { instructions: string; key: string; serverName: string }

/** 每场会话桥上交过的东西存一份(说明、指纹、工具清单):Forsion 退出 / 后台进程重启之后,工作台要打开这场对话时
 *  先替它接上(hold),桥照这份回 —— 下一轮 Forsion 来跑时指纹对得上,就不用再关掉重接。 */
interface BridgeState { key: string; instructions: string; serverName: string; tools: unknown }
const safeName = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s) ? s : `h-${createHash('sha256').update(s).digest('hex').slice(0, 32)}`);
const stateFile = (engineId: string, sessionId: string): string => path.join(tanguHome(), 'engines', safeName(engineId), 'resident', `${safeName(sessionId)}.json`);
function readBridgeState(engineId: string, sessionId: string): BridgeState | null {
  try {
    const v = JSON.parse(readFileSync(stateFile(engineId, sessionId), 'utf8'));
    return v && typeof v.key === 'string' && typeof v.instructions === 'string' && typeof v.serverName === 'string' ? v : null;
  } catch { return null; }
}
function writeBridgeState(engineId: string, sessionId: string, state: BridgeState): void {
  try {
    const file = stateFile(engineId, sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, file);
  } catch (e: any) { console.warn(`[engine:${engineId}] saving bridge state failed: ${e?.message || e}`); }
}

const sameDir = (a: string, b: string): boolean => {
  const r = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return r(a) === r(b);
};

export class ResidentLink {
  readonly engineId: string;
  readonly connectionId: string;
  readonly initialized: InitializeResponse;
  private readonly conn: ClientSideConnection;
  private readonly sessions = new Map<string, OpenSession>();
  private readonly closedSignal: Promise<never>;
  closed = false;
  /** 工作台里发的那一轮(没有 Forsion 的轮在跑时)来的通知条数,只进日志。 */
  outOfTurn = 0;
  /** 探测模型清单时收没人认领的通知(命令清单在建会话之后异步到)。 */
  readonly probeSinks = new Set<(params: any) => void>();

  private constructor(engineId: string, rc: ResidentConnection, conn: ClientSideConnection, initialized: InitializeResponse, closedSignal: Promise<never>) {
    this.engineId = engineId;
    this.connectionId = rc.id;
    this.conn = conn;
    this.initialized = initialized;
    this.closedSignal = closedSignal;
  }

  static async open(engineId: string, rc: ResidentConnection): Promise<ResidentLink> {
    let link: ResidentLink | undefined;
    const route = (sessionId: string): Client | null => link?.sessions.get(sessionId)?.route ?? null;
    const client: Client = {
      sessionUpdate: async (params) => {
        const r = route(params.sessionId);
        if (r) return r.sessionUpdate(params);
        if (link) {
          link.outOfTurn += 1;
          const open = link.sessions.get(params.sessionId);
          if (open) open.lastUsed = Date.now(); // 工作台里正在用的这一场:别被「最久没用」关掉
          for (const sink of link.probeSinks) sink(params);
        }
      },
      requestPermission: async (params) => {
        const r = route(params.sessionId);
        if (r) return r.requestPermission(params);
        console.warn(`[engine:${engineId}] resident session ${String(params.sessionId).slice(0, 8)}: approval asked with no Forsion turn running; answered cancel`);
        return { outcome: { outcome: 'cancelled' } };
      },
      extNotification: async (method, params) => {
        const r = route(typeof params?.sessionId === 'string' ? params.sessionId : '');
        if (r?.extNotification) return r.extNotification(method, params);
      },
    };
    const stream = ndJsonStream(
      Writable.toWeb(rc.input) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(rc.output) as unknown as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => client, stream);
    let markClosed: () => void = () => {};
    const closedSignal = new Promise<never>((_, reject) => { markClosed = () => reject(new Error('The background engine process stopped')); });
    closedSignal.catch(() => {});
    void rc.closed.then(() => { markClosed(); if (link) link.dispose(); });
    const initialized = await Promise.race([
      withTimeout(conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }), HANDSHAKE_TIMEOUT_MS, 'initialize'),
      closedSignal,
    ]);
    link = new ResidentLink(engineId, rc, conn, initialized, closedSignal);
    return link;
  }

  /** 进程没了 / 插件停用:开着的会话都不在了,桥接力收掉。 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sessions.values()) void s.relay?.close().catch(() => {});
    this.sessions.clear();
  }

  isOpen(sessionId: string): boolean { return this.sessions.has(sessionId); }

  private async closeSession(s: OpenSession): Promise<void> {
    this.sessions.delete(s.id);
    try { await withTimeout(this.conn.extMethod('session/close', { sessionId: s.id }), 5000, 'closeSession'); }
    catch (e) { console.warn(`[engine:${this.engineId}] closing session ${s.id} failed: ${acpErrorText(e)}`); }
    await s.relay?.close().catch(() => {});
  }

  private pruning = false;
  /** 开着的太多:关最久没用、又没在跑的。一次只一个在修剪;每关一个都重新挑(等关的时候可能有一轮刚开始跑)。 */
  private async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      while (!this.closed && this.sessions.size > MAX_OPEN_SESSIONS) {
        const victim = [...this.sessions.values()].filter((s) => !s.route).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!victim) break;
        await this.closeSession(victim);
      }
    } finally { this.pruning = false; }
  }

  /**
   * 工作台要打开 Forsion 的这场对话之前,先替它把引擎会话接上(没开着的话):网页界面自己点开一场没人开着的会话会一直占着它,
   * Forsion 之后就再也接不上(实测)。桥照上次存的那份回,下一轮 Forsion 来跑时指纹对得上、不用重接。
   */
  async hold(name: string, sessionId: string, cwd: string): Promise<'open' | 'resumed'> {
    if (this.closed) throw new Error(`${name}'s background process stopped`);
    const current = this.sessions.get(sessionId);
    if (current) { current.lastUsed = Date.now(); return 'open'; }
    const state = readBridgeState(this.engineId, sessionId);
    const relay = state ? await createBridgeRelay({ name: state.serverName, instructions: state.instructions, tools: state.tools }) : null;
    const guard = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([withTimeout(p, HANDSHAKE_TIMEOUT_MS, label), this.closedSignal]) as Promise<T>;
    let s: any;
    try { s = await guard(this.conn.unstable_resumeSession({ cwd, mcpServers: relay ? [relay.server] : [], sessionId }), 'resumeSession'); }
    catch (e: any) {
      await relay?.close().catch(() => {});
      const kind = classifyResumeFailure(e);
      if (kind === 'busy') throw Object.assign(new Error(`${name} has this conversation open elsewhere: ${acpErrorText(e)}`), { externalSessionBusy: true });
      if (kind === 'gone') throw Object.assign(new Error(`${name} no longer has this conversation: ${acpErrorText(e)}`), { externalSessionGone: true });
      throw e;
    }
    this.sessions.set(sessionId, { id: sessionId, cwd, key: state?.key ?? '', relay, route: null, sel: mapAcpConfigOptions(s?.configOptions), lastUsed: Date.now() });
    console.log(`[engine:${this.engineId}] resident session ${sessionId.slice(0, 8)}: held for the workbench${state ? '' : ' (no saved handoff)'}`);
    notifyResidentHost(this.engineId, { type: 'held', engineSessionId: sessionId });
    void this.prune().catch(() => {});
    return 'resumed';
  }

  /**
   * 模型清单 / 命令(同 acpEngine.probeAcpEngine,只是不另起进程:另起一个开在同一份 DSH 目录上会和这个进程抢会话)。
   * 复用固定目录下的探测会话,探完关掉,不占着。
   */
  async probe(opts: { reuseSessionId?: string; cwd: string }): Promise<EngineCapabilities & { probeSessionId?: string }> {
    if (this.closed) throw new Error('The background engine process stopped');
    let commands: EngineCapabilities['commands'] = [];
    let got: () => void = () => {};
    const received = new Promise<void>((r) => { got = r; });
    const sink = (params: any): void => {
      const u = params?.update;
      if (u?.sessionUpdate === 'available_commands_update' && !this.sessions.has(params.sessionId)) { commands = mapAcpCommands(u.availableCommands); got(); }
    };
    this.probeSinks.add(sink);
    const guard = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([withTimeout(p, HANDSHAKE_TIMEOUT_MS, label), this.closedSignal]) as Promise<T>;
    try {
      const canLoad = !!this.initialized.agentCapabilities?.loadSession;
      const sessionCaps = (this.initialized.agentCapabilities as any)?.sessionCapabilities;
      const canResume = !!sessionCaps?.resume;
      const reuse = canResume && !canLoad;
      let s: any;
      let probeSessionId: string | undefined;
      if (reuse && opts.reuseSessionId && !this.sessions.has(opts.reuseSessionId)) {
        try { s = await guard(this.conn.unstable_resumeSession({ cwd: opts.cwd, mcpServers: [], sessionId: opts.reuseSessionId }), 'resumeSession'); probeSessionId = opts.reuseSessionId; }
        catch { s = undefined; }
      }
      if (!s) {
        s = await guard(this.conn.newSession({ cwd: opts.cwd, mcpServers: [] }), 'newSession');
        if (reuse) probeSessionId = s.sessionId;
      }
      const viaModels = mapAcpModels(s?.models);
      const sel = mapAcpConfigOptions(s?.configOptions);
      const fromConfig = !viaModels.models.length && sel.models.length > 0;
      await Promise.race([received, new Promise<void>((r) => setTimeout(r, 1500))]);
      const sid = probeSessionId || s?.sessionId;
      if (sid && sessionCaps?.close) await withTimeout(this.conn.extMethod('session/close', { sessionId: sid }), 3000, 'closeSession').catch(() => {});
      return {
        models: fromConfig ? sel.models : viaModels.models,
        currentModelId: fromConfig ? sel.currentModelId : viaModels.currentModelId,
        commands, loadSession: canLoad, resume: canResume, modes: s?.modes?.availableModes,
        ...(sel.thoughtLevels.length ? { thoughtLevels: sel.thoughtLevels, currentThoughtLevel: sel.currentThoughtLevel } : {}),
        ...(probeSessionId ? { probeSessionId } : {}),
      };
    } finally { this.probeSinks.delete(sink); }
  }

  async run(def: EngineDef, ctx: EngineRunCtx, handoff?: ResidentHandoff): Promise<EngineResult> {
    if (this.closed) throw new Error(`${def.name}'s background process stopped. Send again.`);
    const cwd = ctx.cwd || process.cwd();
    let sessionId = '';
    // 停掉只发 cancel(进程是大家的,不杀),但要有时限:引擎迟迟收不住这一轮,就按停止收尾、把这场会话关掉,别让对话一直挂着
    let stuck = false;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let rejectStop: (e: Error) => void = () => {};
    const stopBound = new Promise<never>((_, reject) => { rejectStop = reject; });
    stopBound.catch(() => {});
    const onAbort = (): void => {
      if (sessionId) void this.conn.cancel({ sessionId }).catch(() => {});
      if (stopTimer) return;
      stopTimer = setTimeout(() => {
        stuck = true;
        const msg = `${def.name} did not stop this turn in time; the conversation will reopen on the next message.`;
        rejectStop(ctx.signal.aborted ? stoppedError(msg) : new Error(msg)); // 看门狗到点(不是用户按的停止)按失败收尾
      }, CANCEL_GRACE_MS);
    };

    // 不活动看门狗同 runAcpEngine:到点只发 cancel(进程是大家的,不杀)。审批期间停表。
    const ENGINE_IDLE_MS = Number(process.env.TANGU_ENGINE_IDLE_TIMEOUT_MS) || 300_000;
    let engineIdle: ReturnType<typeof setTimeout> | null = null;
    let idleFired = false;
    let idlePaused = false; // DSH 说审批在工作台里等着(_forsion/notice)期间停表:用户去工作台批,不能五分钟后被取消
    const armEngineIdle = (): void => {
      if (ctx.signal.aborted || idlePaused) return;
      if (engineIdle) clearTimeout(engineIdle);
      engineIdle = setTimeout(() => { idleFired = true; onAbort(); }, ENGINE_IDLE_MS);
    };
    const wrappedCtx: AcpClientCtx = {
      signal: ctx.signal,
      publish: (type, payload) => { armEngineIdle(); ctx.publish(type, payload); },
      hideToolPrefix: ctx.hideToolPrefix,
      onModel: ctx.onModel,
      touch: armEngineIdle,
      waitingElsewhere: (waiting) => {
        idlePaused = waiting;
        if (waiting) { if (engineIdle) { clearTimeout(engineIdle); engineIdle = null; } } else armEngineIdle();
      },
      requestApproval: async (preview, toolCall) => {
        if (engineIdle) { clearTimeout(engineIdle); engineIdle = null; }
        try { return await ctx.requestApproval(preview, toolCall); }
        finally { armEngineIdle(); }
      },
    };
    const { client, result } = createAcpClient(def.name, wrappedCtx);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const guard = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([withTimeout(p, HANDSHAKE_TIMEOUT_MS, label), this.closedSignal]) as Promise<T>;

    const key = handoff?.key ?? '';
    const target = ctx.mcpServers?.find((s): s is Extract<typeof s, { type: 'http' }> => 'type' in s && s.type === 'http');
    const relayTarget = target ? { url: target.url, headers: target.headers } : null;
    let open: OpenSession | undefined;
    try {
      const agentName = typeof this.initialized.agentInfo?.name === 'string' ? this.initialized.agentInfo.name : undefined;
      const canResume = !!(this.initialized.agentCapabilities as any)?.sessionCapabilities?.resume;
      if (!canResume) throw new Error(`${def.name} cannot keep a session across turns, so it cannot run in the background`);
      const via = 'resume' as const;
      const verifiedForChat = chatResumeVerified(via, agentName);
      let resumeSessionId = ctx.resumeSessionId;
      if (resumeSessionId && ctx.resumeFromAgent !== undefined && !(ctx.resumeFromAgent === null || ctx.resumeFromAgent === agentName)) {
        console.log(`[engine:${def.id}] not continuing session ${resumeSessionId}: it was recorded by ${ctx.resumeFromAgent}, this is ${agentName}; starting a new session`);
        resumeSessionId = undefined;
      }
      const makeRelay = async (): Promise<BridgeRelay | null> => {
        if (!handoff) return null;
        const relay = await createBridgeRelay({ name: handoff.serverName, instructions: handoff.instructions });
        relay.setTarget(relayTarget);
        return relay;
      };
      let s: any = null;
      if (resumeSessionId) {
        const current = this.sessions.get(resumeSessionId);
        if (current?.route) throw new Error(`${def.name} is already running a turn of this conversation`);
        if (current && current.key === key && sameDir(current.cwd, cwd)) {
          open = current; // 一直开着、交接没变:接着用,不重接(重接会让工作台里开着的这一场变成「会话不可用」)
          open.relay?.setTarget(relayTarget);
          console.log(`[engine:${def.id}] resident session ${resumeSessionId.slice(0, 8)}: kept open`);
        } else {
          if (current) await this.closeSession(current);
          const relay = await makeRelay();
          try { s = await guard(this.conn.unstable_resumeSession({ cwd, mcpServers: relay ? [relay.server] : [], sessionId: resumeSessionId }), 'resumeSession'); }
          catch (e: any) {
            await relay?.close().catch(() => {});
            if (ctx.signal.aborted) throw e;
            const kind = classifyResumeFailure(e);
            if (kind === 'gone') throw Object.assign(new Error(`${def.name} no longer has the earlier session of this conversation (${acpErrorText(e)}).`), { externalSessionGone: true });
            if (kind === 'busy') throw Object.assign(new Error(`${def.name} has this conversation open in its workbench or in another window, which keeps it until the background ${def.name} restarts. Restart ${def.name} from this agent's Harness card, then send again. (${acpErrorText(e)})`), { externalSessionBusy: true });
            if (e instanceof Error) throw e;
            throw new Error(`${def.name} could not continue the earlier session: ${acpErrorText(e)}`);
          }
          open = { id: resumeSessionId, cwd, key, relay, route: null, lastUsed: Date.now() };
          this.sessions.set(resumeSessionId, open);
          console.log(`[engine:${def.id}] resident session ${resumeSessionId.slice(0, 8)}: ${current ? 'reopened (handoff changed)' : 'resumed'}`);
          // 工作台里开着这一场的页面:关掉重接之后它变成「会话不可用」,要重载才接得上(实测)。告诉插件
          if (current) notifyResidentHost(this.engineId, { type: 'reopened', engineSessionId: resumeSessionId, sessionId: ctx.sessionId });
        }
        sessionId = resumeSessionId;
      } else {
        const relay = await makeRelay();
        try { s = await guard(this.conn.newSession({ cwd, mcpServers: relay ? [relay.server] : [] }), 'newSession'); }
        catch (e) {
          await relay?.close().catch(() => {});
          if (ctx.signal.aborted) throw e;
          throw new Error(`${def.name} could not start a session: ${acpErrorText(e)}`); // 带上 DSH 给的细节(只有「Internal error」查不出是哪座桥)
        }
        sessionId = s.sessionId;
        open = { id: sessionId, cwd, key, relay, route: null, lastUsed: Date.now() };
        this.sessions.set(sessionId, open);
        console.log(`[engine:${def.id}] resident session ${sessionId.slice(0, 8)}: new`);
      }
      open.route = client;
      // 准备会话的这段时间里被停掉了:那时还没有会话可 cancel,这里不再往下发提问
      if (ctx.signal.aborted) throw stoppedError();
      try { await ctx.onSession?.({ id: sessionId, resumable: true, resumed: !!resumeSessionId, via, verifiedForChat, ...(agentName ? { agent: agentName } : {}) }); }
      catch (e: any) { console.warn(`[engine] onSession failed: ${e?.message || e}`); }
      // 会话一直开着(这一轮没有回包)时,缓存里的「当前模型」可能已经被工作台里换掉了:有指定模型就照样再设一次
      const known = s || !open.sel ? open.sel : { ...open.sel, currentModelId: undefined };
      const sel = await applyEngineModel(this.conn, sessionId, s, ctx.engineModelId, def.id, guard, known);
      open.sel = sel;
      try { ctx.onModel?.(sel.currentModelId); } catch { /* 只是告知 */ }
      if (ctx.signal.aborted) throw stoppedError();
      armEngineIdle();
      let res: Awaited<ReturnType<ClientSideConnection['prompt']>>;
      try {
        res = await Promise.race([this.conn.prompt({ sessionId, prompt: [{ type: 'text', text: ctx.message }] }), this.closedSignal, stopBound]);
      } catch (e: any) {
        const route = ctx.signal.aborted ? null : missingApiKeyRoute(e);
        if (route === null) throw e;
        throw modelNoApiKeyError(def.name, sel, route, acpErrorText(e));
      }
      if (idleFired && !ctx.signal.aborted) throw new Error(`${def.name} went quiet for too long; this turn was stopped.`);
      return { ...result(), stopReason: res.stopReason, externalSessionId: sessionId };
    } finally {
      if (engineIdle) clearTimeout(engineIdle);
      if (stopTimer) clearTimeout(stopTimer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (open && stuck) {
        open.route = null;
        console.warn(`[engine:${def.id}] resident session ${open.id.slice(0, 8)}: did not stop in time, closing it`);
        await this.closeSession(open).catch(() => {});
        open = undefined;
      }
      if (open) {
        open.route = null; open.relay?.setTarget(null); open.lastUsed = Date.now();
        if (open.relay && handoff && open.key === handoff.key) writeBridgeState(this.engineId, open.id, { key: open.key, instructions: handoff.instructions, serverName: handoff.serverName, tools: open.relay.lastTools() });
      }
      void this.prune().catch(() => {});
    }
  }
}

const links = new Map<string, Promise<ResidentLink | null>>();
onResidentHostChange((engineId) => {
  const cur = links.get(engineId);
  links.delete(engineId);
  void cur?.then((l) => l?.dispose()).catch(() => {});
});

/**
 * 这个引擎有没有一个可以连的常驻进程:有就给那条连接(没连过就连上),没有 / 插件说现在不该用 → null(照旧每轮起一个进程)。
 * 插件给的进程重启过(connection id 变了)会换一条新连接。
 */
export async function acquireResident(engineId: string, signal?: AbortSignal): Promise<ResidentLink | null> {
  const reg = residentHostFor(engineId);
  if (!reg) return null;
  // 进程重启后,同时来的两轮(对话 + 工作台的 hold)都看到旧连接关了:只许一个去连,另一个等它的结果 ——
  // 同一份 stdio 上挂两个 ACP 客户端,回包就分错了
  for (;;) {
    const cur = links.get(engineId);
    if (!cur) break;
    const l = await cur.catch(() => null);
    if (l && !l.closed) return l;
    if (links.get(engineId) !== cur) continue; // 等的时候别人已经换上了新的:看新的
    links.delete(engineId);
    break;
  }
  const task = (async () => {
    const rc = await reg.host.connect(signal);
    if (!rc) return null;
    return ResidentLink.open(engineId, rc);
  })();
  links.set(engineId, task);
  try {
    const l = await task;
    if (!l && links.get(engineId) === task) links.delete(engineId);
    return l;
  } catch (e) {
    if (links.get(engineId) === task) links.delete(engineId);
    console.warn(`[engine:${engineId}] background process unavailable: ${acpErrorText(e)}`);
    return null;
  }
}

/** 单测用:清掉缓存的连接。 */
export function resetResidentLinksForTest(): void { for (const l of links.values()) void l.then((x) => x?.dispose()).catch(() => {}); links.clear(); }
