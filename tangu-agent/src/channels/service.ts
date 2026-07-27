/**
 * 通道无关管线:入站消息 → 绑定校验 → (stop/审批/slash) → Tangu run → 回复交付(分段+语音)。
 * 从 wechatRemote 移植泛化;微信/Telegram/QQ 共用,通道差异全部收在 ChannelDriver(传输层)。
 *
 * 会话语义(2026-07 起):无「默认会话」概念——每次连接(扫码/connect)都新建一个会话;
 * 通道会话统一落在该通道专属工作区(project_path),桌面侧栏按文件夹分组展示。
 * 新会话创建时盖上通道默认 Agent / LLM / 画图 / 语音模型(见 stampSession)。
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from '../services/runStore.js';
import { abortRun, enqueueRun } from '../services/agentLoop.js';
import { subscribe } from '../services/eventBus.js';
import { resolveApproval } from '../services/approvals.js';
import { readAgentsMeta, listAgents, getAgent } from '../agents/agentRegistry.js';
import { resolveReplySegment, splitMessage, segmentDelayMs } from '../services/replySegment.js';
import { resolveVoiceMessage, synthesizeVoiceWav, VOICE_MESSAGE_PLUGIN_ID } from '../services/voiceMessage.js';
import { setPluginEnabled, setScopeSettings } from '../plugins/settingsStore.js';
import { channelSettings, channelWorkspaceDir } from './config.js';
import type { ApprovalMode, ChannelDriver, ChannelInbound, ChannelKind, SendResult } from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const RUN_REPLY_TIMEOUT_MS = 180_000;

interface BindingRow {
  id: string;
  user_id: string;
  channel: string;
  account_id: string;
  peer_id: string | null;
  session_id: string;
  remote_approval_mode: ApprovalMode;
}

export interface ChannelServiceOpts {
  kind: ChannelKind;
  driver: ChannelDriver;
  /** 未绑定 peer 收到消息时的提示。 */
  unboundHint: string;
  /** 入站文件落盘目录名(微信沿用历史 wechat-inbox)。 */
  inboxDirName: string;
  /** 新会话默认标题。 */
  sessionTitle: string;
}

export function parseJson(v: any): any {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export class ChannelService {
  readonly kind: ChannelKind;
  readonly driver: ChannelDriver;
  private readonly opts: ChannelServiceOpts;
  private readonly activeRunsByPeer = new Map<string, string>();
  // 通道内审批:peer → 当前待批操作(收到 approval_request 时登记;用户回「批准/拒绝」时取用)。
  private readonly pendingApprovalByPeer = new Map<string, { runId: string; approvalId: string; preview: string; agentSlug?: string }>();
  // typing 指示:peer → 周期性重发「正在输入」的定时器(run 期间开启,出回复时关闭)。
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  // 挂起的 waitForRunReply 强制结束器:stop()/服务重载时把所有等待中的回复 settle 掉,避免泄漏。
  private readonly pendingSettlers = new Set<() => void>();

  constructor(opts: ChannelServiceOpts) {
    this.kind = opts.kind;
    this.driver = opts.driver;
    this.opts = opts;
  }

  settings() { return channelSettings(this.kind); }
  workspaceDir(): string { return channelWorkspaceDir(this.kind); }
  private async ensureWorkspaceDir(): Promise<string> {
    const dir = this.workspaceDir();
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }
  private peerKey(accountId: string, peerId: string): string { return `${accountId}:${peerId}`; }

  /** 结束所有挂起等待 + 定时器(通道停止/重载时)。 */
  releasePending(): void {
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    for (const settle of [...this.pendingSettlers]) settle();
    this.pendingSettlers.clear();
  }

  // ── 绑定/会话 ──

  /**
   * 连接账号:登记账号行 + 作废该用户本通道全部旧绑定 + 新建绑定与**全新会话**。
   * 「连接即新会话」——不复用旧会话;历史会话仍留在通道工作区文件夹里可切回(/switch)。
   */
  async bindAccount(input: { userId: string; accountId: string; peerId?: string | null; label?: string | null; approvalMode?: ApprovalMode }): Promise<{ sessionId: string }> {
    const st = this.settings();
    const approval = input.approvalMode || st.approvalMode;
    const sessionId = await this.createChannelSession(input.userId, undefined, undefined);
    await query(
      `INSERT INTO tangu_wechat_accounts (id, user_id, wx_user_id, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET status = 'active', wx_user_id = ?, channel = ?, updated_at = CURRENT_TIMESTAMP`,
      [input.accountId, input.userId, input.label || null, this.kind, input.label || null, this.kind],
    );
    // 单活跃绑定不变式:每 (用户, 通道) 同一时刻只有一个 is_active 绑定。
    await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE WHERE user_id = ? AND channel = ?`, [input.userId, this.kind]);
    await query(
      `INSERT INTO tangu_wechat_bindings (id, user_id, channel, account_id, peer_id, session_id, remote_approval_mode, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [uuidv4(), input.userId, this.kind, input.accountId, input.peerId || null, sessionId, approval],
    );
    return { sessionId };
  }

  async disconnect(userId: string, accountId?: string): Promise<{ ok: boolean }> {
    if (accountId) {
      await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ? AND account_id = ?`, [userId, this.kind, accountId]);
      await query(`UPDATE tangu_wechat_accounts SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ? AND id = ?`, [userId, this.kind, accountId]);
    } else {
      await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ?`, [userId, this.kind]);
      await query(`UPDATE tangu_wechat_accounts SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ?`, [userId, this.kind]);
    }
    return { ok: true };
  }

  /** 当前活跃绑定(含 peer 是否已确认),供状态展示与收件箱转发寻址。 */
  async activeBinding(userId: string): Promise<BindingRow | null> {
    const rows = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings WHERE user_id = ? AND channel = ? AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
      [userId, this.kind],
    );
    return (rows[0] as BindingRow) || null;
  }

  private async findBinding(accountId: string, peerId: string): Promise<BindingRow | null> {
    const exact = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings
       WHERE channel = ? AND account_id = ? AND peer_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [this.kind, accountId, peerId],
    );
    if (exact[0]) return exact[0] as BindingRow;
    const fallback = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings
       WHERE channel = ? AND account_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [this.kind, accountId],
    );
    const b = fallback[0] as BindingRow | undefined;
    if (b && !b.peer_id) {
      // 未绑定联系人的 binding:收第一个发消息的 peer 作为其专属联系人(TOFU)。
      await query(`UPDATE tangu_wechat_bindings SET peer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [peerId, b.id]);
      b.peer_id = peerId;
      return b;
    }
    // binding 已绑定其它联系人 → 拒绝其他 peer(peer 隔离,避免任意人借同一 binding 执行 host)。
    return null;
  }

  /** 在通道工作区新建会话并盖上通道默认(Agent/LLM/画图模型/审批)。 */
  async createChannelSession(userId: string, modelId?: string, title?: string): Promise<string> {
    const st = this.settings();
    const ws = await this.ensureWorkspaceDir();
    const profile = deps().profile;
    const mid = modelId || st.modelId || profile.defaultModelId || '';
    const id = uuidv4();
    await deps().state.autoCreateSession({ id, userId, appId: profile.appId, title: title || this.opts.sessionTitle, modelId: mid });
    // project_path 让桌面侧栏把它归入通道工作区组;cwd 让 host 执行有真实工作目录。
    await query(`UPDATE chat_sessions SET project_path = ? WHERE id = ?`, [ws, id]);
    const cfg: any = {
      execMode: 'host',
      approvalMode: st.approvalMode,
      cwd: ws,
      agentSlug: st.agentSlug || readAgentsMeta().defaultSlug,
    };
    if (st.imageModelId) cfg.imageModelId = st.imageModelId;
    await deps().state.setAgentConfig(id, JSON.stringify(cfg));
    return id;
  }

  /** 列出该用户本通道工作区下的会话(标注哪个是正在连接的)。 */
  async listProjectSessions(userId: string): Promise<Array<{ id: string; title: string; updated_at: any; connected: boolean; agentSlug: string | null }>> {
    const rows = await query<any[]>(
      `SELECT id, title, updated_at, agent_config FROM chat_sessions WHERE user_id = ? AND project_path = ? ORDER BY updated_at DESC`,
      [userId, this.workspaceDir()],
    );
    const binding = await this.activeBinding(userId);
    const connected = binding?.session_id ?? null;
    return rows.map((r) => ({ id: r.id, title: r.title || this.opts.sessionTitle, updated_at: r.updated_at, connected: r.id === connected, agentSlug: (parseJson(r.agent_config) || {}).agentSlug || null }));
  }

  /** 设置某会话使用的 Normal Agent(merge agentSlug)。 */
  async setSessionAgent(userId: string, sessionId: string, slug: string): Promise<{ ok: boolean }> {
    const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
    if (!rows[0]) throw new Error('Session not found');
    const cfg = parseJson(rows[0].agent_config) || {};
    await deps().state.setAgentConfig(sessionId, JSON.stringify({ ...cfg, agentSlug: slug }));
    return { ok: true };
  }

  /** 把「正在连接的 session」切换到 sessionId(校验归属;兜底补齐 host+cwd)。 */
  async setConnectedSession(userId: string, sessionId: string): Promise<{ ok: boolean }> {
    const rows = await query<any[]>(`SELECT agent_config, project_path FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
    const s = rows[0];
    if (!s) throw new Error('Session not found');
    if (s.project_path !== this.workspaceDir()) throw new Error('只能连接本通道工作区下的会话');
    const cfg = parseJson(s.agent_config) || {};
    if (cfg.execMode !== 'host' || !cfg.cwd) {
      await deps().state.setAgentConfig(sessionId, JSON.stringify({ ...cfg, execMode: 'host', approvalMode: cfg.approvalMode || this.settings().approvalMode, cwd: cfg.cwd || s.project_path || this.workspaceDir() }));
    }
    await query(`UPDATE tangu_wechat_bindings SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ? AND is_active = TRUE`, [sessionId, userId, this.kind]);
    return { ok: true };
  }

  /**
   * 把一份媒体(图片/文件)发送到某会话当前连接的通道 peer。
   * 供 builtin 工具(channel_send_file / channel_send_image)与插件 SDK 调用。
   */
  async sendMediaForSession(userId: string, sessionId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult> {
    const rows = await query<any[]>(
      `SELECT account_id, peer_id FROM tangu_wechat_bindings
       WHERE session_id = ? AND user_id = ? AND channel = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, userId, this.kind],
    );
    const b = rows[0];
    if (!b) return { ok: false, error: '该会话未连接通道(没有活跃绑定)。请先在 Tangu Desktop 设置里连接通道,并把此会话设为正在连接。' };
    if (!b.peer_id) return { ok: false, error: '通道尚未确定联系人。请先让对方发一条消息,再重试发送。' };
    if (!this.driver.sendMedia) return { ok: false, error: '该通道不支持发送媒体。' };
    return this.driver.sendMedia(b.account_id, b.peer_id, buffer, opts, signal);
  }

  /** 给该用户当前活跃绑定的 peer 发一条文本(收件箱转发等主动推送用)。 */
  async sendToOwner(userId: string, text: string): Promise<SendResult> {
    const b = await this.activeBinding(userId);
    if (!b) return { ok: false, error: 'no active binding' };
    if (!b.peer_id) return { ok: false, error: 'peer not established yet' };
    return this.driver.send(b.account_id, b.peer_id, text);
  }

  // ── 入站管线 ──

  async handleInbound(msg: ChannelInbound): Promise<string> {
    const text = msg.text.trim();
    const attachments = msg.attachments ?? [];
    const key = this.peerKey(msg.accountId, msg.peerId);
    // 先校验绑定:stop / 批准拒绝 / slash / 普通任务 都要求该 peer 已绑定(防未绑定 peer 绕过执行)。
    const binding = await this.findBinding(msg.accountId, msg.peerId);
    if (!binding) return this.opts.unboundHint;

    // Channel Session 关闭时不驱动 agent 会话(收件箱转发独立于此,仍可能在推送)。
    if (!this.settings().sessions) return '通道会话功能当前已关闭(仅收件箱转发在工作)。可在 Tangu Desktop 设置 → 通道 里开启。';

    const activeRun = this.activeRunsByPeer.get(key);
    if (/^(stop|停止|取消|中止)$/i.test(text)) {
      if (activeRun) {
        abortRun(activeRun);
        this.activeRunsByPeer.delete(key);
        return '已停止当前 Tangu Agent 任务。';
      }
      return '当前没有正在运行的 Tangu Agent 任务。';
    }

    // 通道内审批:有待批操作时,「批准/拒绝」直接放行或取消(无需回桌面)。
    const pendingApproval = this.pendingApprovalByPeer.get(key);
    if (pendingApproval) {
      if (/^(批准|同意|确认|可以|好的?|是的?|yes|y|ok|approve|👍)$/i.test(text)) {
        this.pendingApprovalByPeer.delete(key);
        const ok = resolveApproval(pendingApproval.approvalId, { action: 'approve' });
        return ok ? this.waitForRunReply(pendingApproval.runId, key, msg.accountId, msg.peerId, pendingApproval.agentSlug) : '该操作已过期或已在别处处理。';
      }
      if (/^(拒绝|不同意|不行|否|不|no|n|reject)$/i.test(text)) {
        this.pendingApprovalByPeer.delete(key);
        const ok = resolveApproval(pendingApproval.approvalId, { action: 'reject' });
        return ok ? this.waitForRunReply(pendingApproval.runId, key, msg.accountId, msg.peerId, pendingApproval.agentSlug) : '该操作已过期或已在别处处理。';
      }
    }

    // 通道 slash 命令:/new /list /switch /agents /agent /voice /text /help。
    if (text.startsWith('/')) return this.handleSlash(binding, text);

    const rows = await query<any[]>(`SELECT model_id, agent_config, project_path FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [binding.session_id, binding.user_id]);
    const session = rows[0];
    if (!session) return '绑定的 Tangu 会话不存在,请在 Desktop 重新连接通道。';
    const modelId = session.model_id || this.settings().modelId || deps().profile.defaultModelId || '';
    if (!modelId) return 'Tangu Agent 尚未配置默认模型,请先在 Desktop 选择模型。';

    // 上一个待批操作未处理就发来新任务 → 视为放弃,拒绝旧审批,避免旧 run 永久挂起等审批。
    const stale = this.pendingApprovalByPeer.get(key);
    if (stale) { resolveApproval(stale.approvalId, { action: 'reject' }); this.pendingApprovalByPeer.delete(key); }

    const runId = uuidv4();
    const assistantMessageId = uuidv4();
    const userMessageId = uuidv4();
    const currentCfg = parseJson(session.agent_config) || {};
    const st = this.settings();
    const agentConfig: any = {
      ...currentCfg,
      execMode: 'host',
      approvalMode: binding.remote_approval_mode || 'auto-edit',
      // host 执行需要真实 cwd:优先会话已存 cwd,其次 project_path,最后兜底通道工作区。
      cwd: currentCfg.cwd || session.project_path || this.workspaceDir(),
      // 会话已选 agent 则用之,否则通道默认 agent,再兜底用户全局默认 agent。
      agentSlug: currentCfg.agentSlug || st.agentSlug || readAgentsMeta().defaultSlug,
    };
    if (!agentConfig.imageModelId && st.imageModelId) agentConfig.imageModelId = st.imageModelId;
    // 入站文件 → 落盘到会话工作区 <channel>-inbox/,把相对路径写进消息(host 工具可直接读)。
    const fileNotes: string[] = [];
    for (const f of msg.files ?? []) {
      try {
        const saved = await this.saveInboundFile(agentConfig.cwd, f);
        fileNotes.push(`[用户发来文件,已保存到 ${saved}]`);
      } catch (e: any) {
        fileNotes.push(`[用户发来文件 ${f.name},但保存失败:${e?.message || e}]`);
      }
    }
    // 纯图片消息给个占位文本:部分 provider(如 Anthropic)拒绝空文本块,聊天记录里也更可读。
    const message = [text, ...fileNotes].filter(Boolean).join('\n') || (attachments.length ? '[图片]' : '');
    await createRun({
      id: runId,
      sessionId: binding.session_id,
      userId: binding.user_id,
      appId: deps().profile.appId,
      modelId,
      assistantMessageId,
      input: {
        message,
        userMessageId,
        attachments, // 通道入站图片 → 与网页发图同一条多模态路径
        agentConfig,
        source: { channel: this.kind, accountId: msg.accountId, openid: msg.peerId, messageId: msg.messageId },
      },
    });
    this.activeRunsByPeer.set(key, runId);
    enqueueRun(binding.session_id, runId);
    return this.waitForRunReply(runId, key, msg.accountId, msg.peerId, agentConfig.agentSlug);
  }

  /**
   * 把一个入站文件写到会话工作区的 <channel>-inbox/ 下,返回相对 cwd 的路径。
   * 文件名做基本清洗(去路径分隔等),重名时追加 -1/-2… 不覆盖旧文件。
   */
  private async saveInboundFile(cwd: string, f: { name: string; buffer: Buffer }): Promise<string> {
    const inbox = path.join(cwd, this.opts.inboxDirName);
    await fsp.mkdir(inbox, { recursive: true });
    const safe = path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || `${this.kind}-file`;
    const ext = path.extname(safe);
    const stem = path.basename(safe, ext);
    let target = path.join(inbox, safe);
    for (let i = 1; i <= 99; i++) {
      try { await fsp.access(target); } catch { break; } // 不存在 → 用它
      target = path.join(inbox, `${stem}-${i}${ext}`);
    }
    await fsp.writeFile(target, f.buffer);
    return path.relative(cwd, target);
  }

  /**
   * 等待该 run 的「下一个里程碑」并把一条回复发回通道。
   * 每次等待结束即退订(支持多轮审批往返而不堆积监听器):
   *  - approval_request → 登记待批 + 回发 preview(run 仍挂起等用户回「批准/拒绝」),terminal=false
   *  - done/error → 终止,清理 peer 状态,terminal=true
   */
  private waitForRunReply(runId: string, key: string, accountId: string, peerId: string, agentSlug?: string): Promise<string> {
    let settled = false;
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    this.startTyping(accountId, peerId, key);
    return new Promise((resolve) => {
      // 送一条回复给通道:首条用 resolve(由驱动自动回发);超时已回过提示后,改主动 send 推送。
      const deliver = (text: string): void => {
        if (!settled) { settled = true; resolve(text); }
        else void this.driver.send(accountId, peerId, text);
      };
      // 结束本次等待:退订 + 停 typing;terminal 时清 peer 运行态。
      const close = (terminal: boolean): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.stopTyping(accountId, peerId, key);
        this.pendingSettlers.delete(forceSettle);
        if (terminal) {
          // 只清「本 run」的登记:新消息可能已把 activeRunsByPeer 指向新 run,别把它误删——
          // 否则新 run 的分段循环会因 activeRunsByPeer 变 undefined 而中断(只发第一条)。
          if (this.activeRunsByPeer.get(key) === runId) this.activeRunsByPeer.delete(key);
          this.pendingApprovalByPeer.delete(key);
        }
      };
      // stop()/服务重载时强制结束挂起的等待。
      const forceSettle = (): void => { if (!settled) { settled = true; resolve('通道服务已停止。'); } close(true); };
      this.pendingSettlers.add(forceSettle);
      const timer = setTimeout(() => {
        // 超时:先回一条「仍在执行」并停 typing,但保留订阅 → run 完成时主动把结果推送给通道。
        this.stopTyping(accountId, peerId, key);
        if (!settled) { settled = true; resolve('Tangu Agent 仍在执行中。完成后我会把结果发给你;如需停止,请回复「停止」。'); }
      }, RUN_REPLY_TIMEOUT_MS);
      unsubscribe = subscribe(runId, (ev) => {
        if (ev.type === 'approval_request') {
          const approvalId = String(ev.payload?.approvalId || '');
          const preview = String(ev.payload?.preview || ev.payload?.name || '操作');
          if (approvalId) this.pendingApprovalByPeer.set(key, { runId, approvalId, preview, agentSlug });
          deliver(`⚠️ 需要你批准这个操作:\n${preview}\n\n回复「批准」执行,「拒绝」取消,或「停止」结束任务。`);
          close(false); // 退订(用户回「批准」时会新建一次等待重新订阅);保留 run + 待批登记
          return;
        }
        if (ev.type === 'done') {
          // 拟人分段(按 agent,回落全局):该 agent 开启时把回复拆成多条依次发出;否则单条。
          void this.deliverReply(String(ev.payload?.content || '完成。'), deliver, () => close(true), { accountId, peerId, key, runId, agentSlug });
          return;
        }
        if (ev.type === 'error') { deliver(ev.payload?.aborted ? '任务已停止。' : `任务失败:${ev.payload?.error || 'unknown error'}`); close(true); }
      });
    });
  }

  /**
   * 把一条 done 回复送达通道。分段消息插件开启时拆成多条:首段走 deliver(同步回复),其余段
   * 等拟人延迟后经驱动推送;被「停止」清空即停发。末了调 done() 收尾(停 typing + 清 peer 态)。
   */
  private async deliverReply(
    content: string,
    deliver: (text: string) => void,
    done: () => void,
    ctx: { accountId: string; peerId: string; key: string; runId: string; agentSlug?: string },
  ): Promise<void> {
    try {
      const seg = resolveReplySegment(ctx.agentSlug);
      const delayBase = seg.delayBase;
      const segs = seg.enabled ? splitMessage(content) : [content];
      // 只在「被停止」(activeRunsByPeer 整个清掉)时中断;被新消息取代(指向另一个 run)不算——每条回复都要发全,
      // 否则「回复中又发一条消息」会把上一条回复截成只剩第一段(实测的吞消息 bug)。新回复会经驱动限速排队跟在后面。
      deliver(segs[0] ?? content);
      for (let i = 1; i < segs.length; i++) {
        if (!this.activeRunsByPeer.has(ctx.key)) break; // 被「停止」清空 → 停发
        await sleep(segmentDelayMs(segs[i], delayBase));
        if (!this.activeRunsByPeer.has(ctx.key)) break;
        void this.driver.setTyping?.(ctx.accountId, ctx.peerId, true).catch(() => {});
        deliver(segs[i]);
      }
      // 语音模式:文字之外,再把整条回复合成音频、当文件发一份。通道可配 TTS 模型/音色覆盖(缺省沿用「语音朗读」)。
      const st = this.settings();
      const base = resolveVoiceMessage(ctx.agentSlug);
      const voice = { ...base, model: st.ttsModelId || base.model, voice: st.ttsVoice || base.voice };
      if (voice.enabled && voice.wechat && this.driver.sendMedia && this.activeRunsByPeer.has(ctx.key)) {
        if (voice.model) await this.sendVoiceFile(ctx.accountId, ctx.peerId, content, voice);
        else console.warn(`[${this.kind}-channel] 语音已开启但未配置 TTS 模型(设置→模型→语音朗读或通道语音模型),只发了文字。`);
      }
    } catch (e) {
      console.warn(`[${this.kind}-channel] deliverReply failed:`, e);
    } finally {
      done();
    }
  }

  /** 把整条回复合成音频、当**文件**发到通道(voice.wav)。失败静默(文字已发过,不影响主回复)。 */
  private async sendVoiceFile(
    accountId: string,
    peerId: string,
    text: string,
    cfg: { model: string; voice?: string; speed?: number; enabled: boolean; wechat: boolean },
  ): Promise<void> {
    try {
      const audio = await synthesizeVoiceWav(text, cfg); // WAV 字节
      const res = await this.driver.sendMedia?.(accountId, peerId, Buffer.from(audio), { kind: 'file', fileName: 'voice.wav' });
      if (!res?.ok) console.warn(`[${this.kind}-channel] 语音文件发送失败:`, res?.error);
    } catch (e: any) {
      console.warn(`[${this.kind}-channel] 语音文件合成/发送失败:`, e?.message || e);
    }
  }

  // ── typing 指示(run 期间周期重发「正在输入」,出回复时停止)──
  private startTyping(accountId: string, peerId: string, key: string): void {
    if (!this.driver.setTyping) return;
    const existing = this.typingTimers.get(key);
    if (existing) clearInterval(existing); // 多轮审批往返会重入 → 先清旧定时器避免泄漏
    const tick = (): void => { void this.driver.setTyping?.(accountId, peerId, true).catch(() => {}); };
    tick();
    this.typingTimers.set(key, setInterval(tick, 5_000));
  }
  private stopTyping(accountId: string, peerId: string, key: string): void {
    const t = this.typingTimers.get(key);
    if (t) { clearInterval(t); this.typingTimers.delete(key); }
    void this.driver.setTyping?.(accountId, peerId, false).catch(() => {});
  }

  // ── slash 命令 ──
  private async handleSlash(binding: BindingRow, text: string): Promise<string> {
    const parts = text.slice(1).trim().split(/\s+/);
    const c = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    if (c === 'new' || c === 'n' || c === '新建') {
      const sid = await this.createChannelSession(binding.user_id, undefined, arg || undefined);
      await this.setConnectedSession(binding.user_id, sid);
      return '✓ 已新建会话并切换连接。之后的消息都发往这个新会话。回复 /list 查看全部。';
    }
    if (c === 'list' || c === 'ls' || c === '列表') {
      const items = await this.listProjectSessions(binding.user_id);
      if (!items.length) return '当前还没有会话。回复 /new 新建一个。';
      const lines = items.map((s, i) => `${i + 1}. ${s.connected ? '● ' : ''}${s.title || '未命名'}`);
      return `通道会话(● 为正在连接):\n${lines.join('\n')}\n\n回复 /switch <序号> 切换。`;
    }
    if (c === 'switch' || c === 'sw' || c === '切换') {
      const n = parseInt(arg, 10);
      const items = await this.listProjectSessions(binding.user_id);
      if (!Number.isFinite(n) || n < 1 || n > items.length) return `序号无效。回复 /list 查看会话(共 ${items.length} 个)。`;
      await this.setConnectedSession(binding.user_id, items[n - 1].id);
      return `✓ 已切换到会话 ${n}:${items[n - 1].title || '未命名'}。`;
    }
    if (c === 'agents' || c === 'agentlist') {
      const all = await listAgents();
      if (!all.length) return '还没有可用的 Agent。回复 /help 查看其它命令。';
      const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? LIMIT 1`, [binding.session_id]);
      const cur = (parseJson(rows[0]?.agent_config) || {}).agentSlug || this.settings().agentSlug || readAgentsMeta().defaultSlug;
      const lines = all.map((a) => `${a.slug === cur ? '● ' : ''}${a.slug} — ${a.name}`);
      return `可用 Agent(● 为当前):\n${lines.join('\n')}\n\n回复 /agent <slug> 切换。`;
    }
    if (c === 'agent') {
      if (!arg) return '用法:/agent <slug>。回复 /agents 查看可用 Agent。';
      const def = await getAgent(arg);
      if (!def) return `未找到 Agent: ${arg}。回复 /agents 查看可用列表。`;
      const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [binding.session_id, binding.user_id]);
      const cfg = parseJson(rows[0]?.agent_config) || {};
      await deps().state.setAgentConfig(binding.session_id, JSON.stringify({ ...cfg, agentSlug: def.slug }));
      return `✓ 已切换到 Agent:${def.name}(${def.slug})。之后本会话的消息都用它。`;
    }
    if (c === 'voice' || c === 'text' || c === '语音' || c === '文字') {
      const on = c === 'voice' || c === '语音';
      // 目标 = 本会话当前 agent(与 /agent 同源;缺省用默认 agent)。
      const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [binding.session_id, binding.user_id]);
      const slug = (parseJson(rows[0]?.agent_config) || {}).agentSlug || readAgentsMeta().defaultSlug;
      try {
        if (on) await setPluginEnabled(VOICE_MESSAGE_PLUGIN_ID, true); // 确保插件启用(通道-only 用户也能开)
        await setScopeSettings(VOICE_MESSAGE_PLUGIN_ID, { agentSlug: slug }, { apply: on });
      } catch (e: any) {
        return `切换失败:${e?.message || e}`;
      }
      return on
        ? '✓ 已切到语音消息:之后本会话的回复会附带一条可播放的语音文件。需配置 TTS 模型(Desktop 设置 → 模型 → 语音朗读,或通道的语音模型);未配则只发文字。回复 /text 切回文字。'
        : '✓ 已切回文字消息。回复 /voice 再切到语音。';
    }
    if (c === 'help' || c === 'h' || c === '帮助' || c === '?') {
      return ['可用命令:', '/new 新建会话并切换连接', '/list 列出会话(● 为正在连接)', '/switch <序号> 切换正在连接的会话', '/agents 列出可用 Agent', '/agent <slug> 切换本会话的 Agent', '/voice 语音消息 · /text 文字消息', '/help 显示本帮助', '停止 中止当前任务', '批准 / 拒绝 处理待批操作'].join('\n');
    }
    return `未知命令 /${parts[0]}。回复 /help 查看可用命令。`;
  }
}
