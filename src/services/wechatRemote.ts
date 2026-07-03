/**
 * Tangu WeChat Remote：iLink 入站消息 → 本地 Tangu run。
 * token 留在 ~/.tangu/wechat/accounts.json，数据库只记录 account/session/peer 绑定。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { promises as fsp } from 'node:fs';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { query } from '../core/db.js';
import { tanguHome } from '../core/tanguHome.js';
import { getRawSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';
import { createRun } from './runStore.js';
import { abortRun, enqueueRun } from './agentLoop.js';
import { subscribe } from './eventBus.js';
import { resolveApproval } from './approvals.js';
import { IlinkClient, ILINK_BASE_URL } from '../wechat/ilinkClient.js';
import { IlinkRuntime } from '../wechat/ilinkRuntime.js';
import { readAgentsMeta, listAgents, getAgent } from '../agents/agentRegistry.js';
// 拟人分段回复:通道无关 + 按 agent(见 services/replySegment.ts;面板由 plugins/reply-segment 声明,行为留在核心)。
import { resolveReplySegment, splitMessage, segmentDelayMs } from './replySegment.js';
// 语音消息:该 agent 开启时,除文字外再把整条回复合成音频、当**文件**发一份到微信。
// (微信 iLink bot 平台不渲染 bot 发的原生语音气泡——sendmessage 返回成功也不显示,已实测证实;
//  故退而发可播放的音频文件。面板由 plugins/voice-message 声明。)
import { resolveVoiceMessage, synthesizeVoiceWav, VOICE_MESSAGE_PLUGIN_ID } from './voiceMessage.js';
import { setPluginEnabled, setScopeSettings } from '../plugins/settingsStore.js';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto';

interface PendingLogin {
  userId: string;
  sessionId?: string;
  modelId?: string;
  approvalMode: ApprovalMode;
  qrcode: string;
  baseUrl: string;
  expiresAt: number;
}

interface BindingRow {
  id: string;
  user_id: string;
  account_id: string;
  peer_id: string | null;
  session_id: string;
  remote_approval_mode: ApprovalMode;
}

const LOGIN_TTL_MS = 8 * 60_000;
const RUN_REPLY_TIMEOUT_MS = 180_000;
const activeRunsByPeer = new Map<string, string>();

// 微信设置:config.json 的 wechat 段为底,env(TANGU_WECHAT_*)覆盖(桌面注入 / 运维)。
function wechatCfg(): any { return getRawSection('wechat') || {}; }

function enabled(): boolean {
  if (process.env.TANGU_WECHAT_ENABLED !== undefined) return process.env.TANGU_WECHAT_ENABLED !== '0';
  return wechatCfg().enabled !== false; // 默认开(与旧 env 行为一致;桌面总是显式注入)
}

function defaultApprovalMode(): ApprovalMode {
  const v = String(process.env.TANGU_WECHAT_REMOTE_APPROVAL_MODE || wechatCfg().remoteApprovalMode || 'readonly');
  return v === 'auto-edit' || v === 'full-auto' ? v : 'readonly';
}

function stateDir(): string {
  return process.env.TANGU_WECHAT_STATE_DIR || wechatCfg().stateDir || path.join(tanguHome(), 'wechat');
}

/**
 * 微信远程会话的工作区目录(host 执行的 cwd）。桌面端经 TANGU_DEFAULT_WORKSPACE 注入「Forsion/Tangu 默认工作区」;
 * 兜底 ~/Tangu(与桌面默认工作区一致)。不设 cwd 时 host 工具会回退 process.cwd()（后端进程目录），
 * 导致微信触发的 run 在错误目录乱跑 / 无有效回复。
 */
function defaultWorkspaceDir(): string {
  const v = (process.env.TANGU_DEFAULT_WORKSPACE || (getRawSection('workspace') as string) || '').trim();
  return v || path.join(homedir(), 'Tangu');
}

/** 微信远程的专属工作区目录(一个 Project):默认工作区下的 webot 子目录(~/Tangu/webot)。 */
function webotDir(): string {
  return path.join(defaultWorkspaceDir(), 'webot');
}
async function ensureWebotDir(): Promise<string> {
  const dir = webotDir();
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

/**
 * 微信远程「专属独立会话」id:每个用户用确定性 UUID（uuidv5）。
 * 扫几次码都解析到同一个会话 → 微信远程是单一固定会话,不绑当前活跃会话、不跟随桌面新建会话。
 */
const WECHAT_SESSION_NS = '6f4d2b1a-9c3e-5a7f-8b21-0d9e1c2f3a4b';
function wechatSessionId(userId: string): string {
  return uuidv5(`wechat-remote:${userId}`, WECHAT_SESSION_NS);
}

function peerKey(accountId: string, openid: string): string {
  return `${accountId}:${openid}`;
}

class WechatRemoteService {
  private runtime: IlinkRuntime | null = null;
  private started = false;
  private readonly pending = new Map<string, PendingLogin>();
  // 微信内审批:peer → 当前待批操作(收到 approval_request 时登记;用户回「批准/拒绝」时取用)。
  private readonly pendingApprovalByPeer = new Map<string, { runId: string; approvalId: string; preview: string; agentSlug?: string }>();
  // typing 指示:peer → 周期性重发「正在输入」的定时器(run 期间开启,出回复时关闭)。
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  // 挂起的 waitForRunReply 强制结束器:stop()/服务重载时把所有等待中的回复 settle 掉,避免泄漏。
  private readonly pendingSettlers = new Set<() => void>();

  async start(): Promise<void> {
    if (this.started || !enabled()) return;
    // WeChat Remote 是本地/桌面能力；云端 ai-studio profile 不应启动。
    if (!deps().profile.capabilities.hostExec) return;
    this.started = true;
    this.runtime = new IlinkRuntime({
      stateDir: stateDir(),
      onMessage: (msg) => this.handleInbound(msg),
      onSessionExpired: (accountId) => {
        void query(`UPDATE tangu_wechat_accounts SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [accountId]).catch(() => {});
      },
    });
    await this.runtime.loadAccounts();
    this.runtime.startAll();
  }

  stop(): void {
    this.runtime?.shutdown();
    this.runtime = null;
    this.started = false;
    this.pending.clear();
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    for (const settle of [...this.pendingSettlers]) settle();
    this.pendingSettlers.clear();
  }

  private async ensureRuntime(): Promise<IlinkRuntime> {
    await this.start();
    if (!this.runtime) throw new Error('WeChat Remote is disabled or unavailable in this profile');
    return this.runtime;
  }

  async loginStart(input: { userId: string; sessionId?: string; modelId?: string; approvalMode?: ApprovalMode }): Promise<any> {
    const runtime = await this.ensureRuntime();
    void runtime; // start side effect is the important part.
    // 绑定到微信「专属独立会话」:不传 sessionId 时用每用户确定性 id(扫几次都是同一个会话,
    // 不绑当前活跃会话、不跟随桌面新建会话)。
    const sessionId = await this.ensureSession(input.userId, input.sessionId || wechatSessionId(input.userId), input.modelId);
    const { qrcode, qrcodeImg } = await IlinkClient.qrStart();
    if (!qrcode || !qrcodeImg) throw new Error('iLink QR start failed');
    const loginId = randomUUID();
    this.pending.set(loginId, {
      userId: input.userId,
      sessionId,
      modelId: input.modelId,
      approvalMode: input.approvalMode || defaultApprovalMode(),
      qrcode,
      baseUrl: ILINK_BASE_URL,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    this.prunePending();
    return { loginId, qrcode, qrcodeImg, expiresAt: Date.now() + LOGIN_TTL_MS };
  }

  async loginStatus(userId: string, loginId: string): Promise<any> {
    const p = this.pending.get(loginId);
    if (!p || p.userId !== userId) return { status: 'expired' };
    if (p.expiresAt < Date.now()) {
      this.pending.delete(loginId);
      return { status: 'expired' };
    }
    const st = await IlinkClient.qrStatus(p.baseUrl, p.qrcode);
    if (st.status === 'scaned_but_redirect' && st.redirectHost) p.baseUrl = `https://${st.redirectHost}`;
    if (st.status !== 'confirmed') return { status: st.status };
    if (!st.accountId || !st.token) return { status: 'error', detail: 'confirmed but credentials missing' };

    const sessionId = await this.ensureSession(userId, p.sessionId, p.modelId);
    const runtime = await this.ensureRuntime();
    await runtime.addAccount({ accountId: st.accountId, token: st.token, baseUrl: st.baseUrl || p.baseUrl });
    await query(
      `INSERT INTO tangu_wechat_accounts (id, user_id, wx_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET status = 'active', wx_user_id = ?, updated_at = CURRENT_TIMESTAMP`,
      [st.accountId, userId, st.userId || null, st.userId || null],
    );
    // 单活跃绑定不变式:每个用户同一时刻只有一个 is_active 绑定。停掉该用户「所有」旧的活跃绑定
    // (不止当前账号),否则连过第二个微信账号会留两条 is_active,令 session→account 解析(发文件/
    // currentBoundSessionId/setConnectedSession)取到「最近的那条」而非预期账号。
    await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE WHERE user_id = ?`, [userId]);
    await query(
      `INSERT INTO tangu_wechat_bindings (id, user_id, account_id, peer_id, session_id, remote_approval_mode, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [uuidv4(), userId, st.accountId, st.userId || null, sessionId, p.approvalMode],
    );
    this.pending.delete(loginId);
    return { status: 'confirmed', accountId: st.accountId, sessionId };
  }

  async status(userId: string): Promise<any> {
    await this.start();
    const rows = await query<any[]>(
      `SELECT b.id, b.account_id, b.peer_id, b.session_id, b.remote_approval_mode, b.is_active,
              a.status, a.wx_user_id, s.title AS session_title
       FROM tangu_wechat_bindings b
       LEFT JOIN tangu_wechat_accounts a ON a.id = b.account_id
       LEFT JOIN chat_sessions s ON s.id = b.session_id
       WHERE b.user_id = ?
       ORDER BY b.updated_at DESC`,
      [userId],
    );
    return { enabled: enabled(), runtime: this.runtime?.status() || [], bindings: rows };
  }

  async disconnect(userId: string, accountId: string): Promise<any> {
    await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND account_id = ?`, [userId, accountId]);
    await query(`UPDATE tangu_wechat_accounts SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?`, [userId, accountId]);
    await this.runtime?.removeAccount(accountId);
    return { ok: true };
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }

  private async ensureSession(userId: string, sessionId?: string, modelId?: string): Promise<string> {
    const id = sessionId || uuidv4();
    const owner = await deps().state.getSessionOwner(id);
    if (owner && owner !== userId) throw new Error('Session not found');
    if (!owner) {
      const profile = deps().profile;
      const mid = modelId || profile.defaultModelId || '';
      const ws = await ensureWebotDir();
      await deps().state.autoCreateSession({
        id,
        userId,
        appId: profile.appId,
        title: 'WeChat Remote',
        modelId: mid,
      });
      // 落到「微信远程」专属工作区(~/Tangu/webot):project_path 让桌面侧栏把它归入该工作区组;
      // cwd 让 host 执行有真实工作目录(否则回退 process.cwd() → 微信触发的 run 在错误目录乱跑/无回复)。
      await query(`UPDATE chat_sessions SET project_path = ? WHERE id = ?`, [ws, id]);
      await deps().state.setAgentConfig(id, JSON.stringify({ execMode: 'host', approvalMode: defaultApprovalMode(), cwd: ws }));
    }
    return id;
  }

  private async findBinding(accountId: string, openid: string): Promise<BindingRow | null> {
    const exact = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings
       WHERE account_id = ? AND peer_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [accountId, openid],
    );
    if (exact[0]) return exact[0] as BindingRow;
    const fallback = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings
       WHERE account_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [accountId],
    );
    const b = fallback[0] as BindingRow | undefined;
    if (b && !b.peer_id) {
      // 未绑定联系人的 binding:收第一个发消息的 openid 作为其专属联系人。
      await query(`UPDATE tangu_wechat_bindings SET peer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [openid, b.id]);
      b.peer_id = openid;
      return b;
    }
    // binding 已绑定其它联系人 → 拒绝其他 openid(openid 隔离,避免任意人借同一 binding 执行 host)。
    return null;
  }

  private async handleInbound(msg: { accountId: string; openid: string; text: string; messageId?: string; attachments?: Array<{ name: string; mimeType: string; data: string }>; files?: Array<{ name: string; mimeType: string; buffer: Buffer }> }): Promise<string> {
    const text = msg.text.trim();
    const attachments = msg.attachments ?? [];
    const key = peerKey(msg.accountId, msg.openid);
    // 先校验绑定:stop / 批准拒绝 / slash / 普通任务 都要求该 peer 已绑定(防未绑定 openid 绕过执行)。
    const binding = await this.findBinding(msg.accountId, msg.openid);
    if (!binding) return '这个微信账号尚未绑定 Tangu Agent，请先在 Tangu Desktop 设置里扫码连接。';

    const activeRun = activeRunsByPeer.get(key);
    if (/^(stop|停止|取消|中止)$/i.test(text)) {
      if (activeRun) {
        abortRun(activeRun);
        activeRunsByPeer.delete(key);
        return '已停止当前 Tangu Agent 任务。';
      }
      return '当前没有正在运行的 Tangu Agent 任务。';
    }

    // 微信内审批:有待批操作时,「批准/拒绝」直接放行或取消(无需回桌面)。
    const pendingApproval = this.pendingApprovalByPeer.get(key);
    if (pendingApproval) {
      if (/^(批准|同意|确认|可以|好的?|是的?|yes|y|ok|approve|👍)$/i.test(text)) {
        this.pendingApprovalByPeer.delete(key);
        const ok = resolveApproval(pendingApproval.approvalId, { action: 'approve' });
        return ok ? this.waitForRunReply(pendingApproval.runId, key, msg.accountId, msg.openid, pendingApproval.agentSlug) : '该操作已过期或已在别处处理。';
      }
      if (/^(拒绝|不同意|不行|否|不|no|n|reject)$/i.test(text)) {
        this.pendingApprovalByPeer.delete(key);
        const ok = resolveApproval(pendingApproval.approvalId, { action: 'reject' });
        return ok ? this.waitForRunReply(pendingApproval.runId, key, msg.accountId, msg.openid, pendingApproval.agentSlug) : '该操作已过期或已在别处处理。';
      }
    }

    // 微信 bot slash 命令:/new /list /switch /help(操作本「微信远程」Project 下的会话)。
    if (text.startsWith('/')) return this.handleSlash(binding, text);

    const rows = await query<any[]>(`SELECT model_id, agent_config, project_path FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [binding.session_id, binding.user_id]);
    const session = rows[0];
    if (!session) return '绑定的 Tangu 会话不存在，请在 Desktop 重新扫码连接。';
    const modelId = session.model_id || deps().profile.defaultModelId || '';
    if (!modelId) return 'Tangu Agent 尚未配置默认模型，请先在 Desktop 选择模型。';

    // 上一个待批操作未处理就发来新任务 → 视为放弃,拒绝旧审批,避免旧 run 永久挂起等审批。
    const stale = this.pendingApprovalByPeer.get(key);
    if (stale) { resolveApproval(stale.approvalId, { action: 'reject' }); this.pendingApprovalByPeer.delete(key); }

    const runId = uuidv4();
    const assistantMessageId = uuidv4();
    const userMessageId = uuidv4();
    const currentCfg = parseJson(session.agent_config) || {};
    const agentConfig = {
      ...currentCfg,
      execMode: 'host',
      approvalMode: binding.remote_approval_mode || 'readonly',
      // host 执行需要真实 cwd：优先会话已存 cwd，其次 project_path，最后兜底默认工作区
      // （兼容本次修复前创建、project_path 为空的旧绑定）。
      cwd: currentCfg.cwd || session.project_path || webotDir(),
      // 接入 Normal Agent 机制：会话已选则用之，否则用用户设定的默认 agent（兼容无 agentSlug 的旧会话）。
      agentSlug: currentCfg.agentSlug || readAgentsMeta().defaultSlug,
    };
    // 微信入站文件 → 落盘到会话工作区 wechat-inbox/，把相对路径写进消息（host 工具可直接读）。
    const fileNotes: string[] = [];
    for (const f of msg.files ?? []) {
      try {
        const saved = await this.saveInboundFile(agentConfig.cwd, f);
        fileNotes.push(`[用户发来文件，已保存到 ${saved}]`);
      } catch (e: any) {
        fileNotes.push(`[用户发来文件 ${f.name}，但保存失败：${e?.message || e}]`);
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
        attachments, // 微信入站图片（下载解密后 {name,mimeType,data}）→ 与网页发图同一条多模态路径
        agentConfig,
        source: { channel: 'wechat', accountId: msg.accountId, openid: msg.openid, messageId: msg.messageId },
      },
    });
    activeRunsByPeer.set(key, runId);
    enqueueRun(binding.session_id, runId);
    return this.waitForRunReply(runId, key, msg.accountId, msg.openid, agentConfig.agentSlug);
  }

  /**
   * 把一个微信入站文件写到会话工作区的 wechat-inbox/ 下，返回相对 cwd 的路径。
   * 文件名做基本清洗（去路径分隔等），重名时追加 -1/-2… 不覆盖旧文件。
   */
  private async saveInboundFile(cwd: string, f: { name: string; buffer: Buffer }): Promise<string> {
    const inbox = path.join(cwd, 'wechat-inbox');
    await fsp.mkdir(inbox, { recursive: true });
    const safe = path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'wechat-file';
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
   * 等待该 run 的「下一个里程碑」并把一条回复发回微信。
   * 每次等待结束即退订(支持多轮审批往返而不堆积监听器):
   *  - approval_request → 登记待批 + 回发 preview(run 仍挂起等用户回「批准/拒绝」),terminal=false
   *  - done/error → 终止,清理 peer 状态,terminal=true
   */
  private waitForRunReply(runId: string, key: string, accountId: string, openid: string, agentSlug?: string): Promise<string> {
    let settled = false;
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    this.startTyping(accountId, openid, key);
    return new Promise((resolve) => {
      // 送一条回复给微信:首条用 resolve(由 runtime 自动回发);超时已回过提示后,改主动 send 推送。
      const deliver = (text: string): void => {
        if (!settled) { settled = true; resolve(text); }
        else void this.runtime?.send(accountId, openid, text);
      };
      // 结束本次等待:退订 + 停 typing;terminal 时清 peer 运行态。
      const close = (terminal: boolean): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.stopTyping(accountId, openid, key);
        this.pendingSettlers.delete(forceSettle);
        if (terminal) {
          // 只清「本 run」的登记:新消息可能已把 activeRunsByPeer 指向新 run(run2),别把它误删——
          // 否则 run2 的分段循环会因 activeRunsByPeer 变 undefined 而中断(只发第一条)。
          if (activeRunsByPeer.get(key) === runId) activeRunsByPeer.delete(key);
          this.pendingApprovalByPeer.delete(key);
        }
      };
      // stop()/服务重载时强制结束挂起的等待。
      const forceSettle = (): void => { if (!settled) { settled = true; resolve('微信远程服务已停止。'); } close(true); };
      this.pendingSettlers.add(forceSettle);
      const timer = setTimeout(() => {
        // 超时:先回一条「仍在执行」并停 typing,但保留订阅 → run 完成时主动把结果推送给微信。
        this.stopTyping(accountId, openid, key);
        if (!settled) { settled = true; resolve('Tangu Agent 仍在执行中。完成后我会把结果发给你；如需停止,请回复「停止」。'); }
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
          void this.deliverReply(String(ev.payload?.content || '完成。'), deliver, () => close(true), { accountId, openid, key, runId, agentSlug });
          return;
        }
        if (ev.type === 'error') { deliver(ev.payload?.aborted ? '任务已停止。' : `任务失败：${ev.payload?.error || 'unknown error'}`); close(true); }
      });
    });
  }

  /**
   * 把一条 done 回复送达微信。分段消息插件开启时拆成多条:首段走 deliver(同步回复),其余段
   * 等拟人延迟后经 deliver→runtime.send 推送;被「停止」/新任务取代(activeRunsByPeer 变更)即停发。
   * 末了调 done() 收尾(停 typing + 清 peer 态)。typing 由 startTyping 的 5s 定时器在分段期间保持。
   */
  private async deliverReply(
    content: string,
    deliver: (text: string) => void,
    done: () => void,
    ctx: { accountId: string; openid: string; key: string; runId: string; agentSlug?: string },
  ): Promise<void> {
    try {
      const seg = resolveReplySegment(ctx.agentSlug);
      const delayBase = seg.delayBase;
      const segs = seg.enabled ? splitMessage(content) : [content];
      // 文本(始终发,分段插件开启则拆多条):首段走 deliver(同步回复),其余段延迟后推送。
      // 只在「被停止」(activeRunsByPeer 整个清掉)时中断;被新消息取代(指向另一个 run)不算 —— 每条回复都要发全,
      // 否则「回复中又发一条消息」会把上一条回复截成只剩第一段(实测的吞消息 bug)。新回复会经 paced 排队跟在后面。
      deliver(segs[0] ?? content);
      for (let i = 1; i < segs.length; i++) {
        if (!activeRunsByPeer.has(ctx.key)) break; // 被「停止」清空 → 停发
        await sleep(segmentDelayMs(segs[i], delayBase));
        if (!activeRunsByPeer.has(ctx.key)) break;
        void this.runtime?.setTyping(ctx.accountId, ctx.openid, true).catch(() => {});
        deliver(segs[i]);
      }
      // 语音模式:文字之外,再把整条回复合成音频、当文件发一份(bot 发不出原生语音气泡,退而发可播放音频文件)。
      const voice = resolveVoiceMessage(ctx.agentSlug);
      if (voice.enabled && voice.wechat && this.runtime && activeRunsByPeer.has(ctx.key)) {
        if (voice.model) await this.sendVoiceFile(ctx.accountId, ctx.openid, content, voice);
        else console.warn('[wechat-remote] 语音已开启但未配置 TTS 模型(设置→模型→语音朗读),只发了文字。');
      }
    } catch (e) {
      console.warn('[wechat-remote] deliverReply failed:', e);
    } finally {
      done();
    }
  }

  /**
   * 把整条回复合成音频、当**文件**发到微信(voice.wav)。微信 bot 发不出原生语音气泡,这是退路。
   * 失败静默(文字已经发过了,不影响主回复)。合成较慢,期间靠 startTyping 的定时器维持「正在输入」。
   */
  private async sendVoiceFile(
    accountId: string,
    openid: string,
    text: string,
    cfg: { model: string; voice?: string; speed?: number; enabled: boolean; wechat: boolean },
  ): Promise<void> {
    try {
      const audio = await synthesizeVoiceWav(text, cfg); // WAV 字节
      const res = await this.runtime?.sendMedia(accountId, openid, Buffer.from(audio), { kind: 'file', fileName: 'voice.wav' });
      if (!res?.ok) console.warn('[wechat-remote] 语音文件发送失败:', res?.error);
    } catch (e: any) {
      console.warn('[wechat-remote] 语音文件合成/发送失败:', e?.message || e);
    }
  }

  // ── typing 指示(run 期间周期重发「正在输入」,出回复时停止)──
  private startTyping(accountId: string, openid: string, key: string): void {
    if (!this.runtime) return;
    const existing = this.typingTimers.get(key);
    if (existing) clearInterval(existing); // 多轮审批往返会重入 → 先清旧定时器避免泄漏
    const tick = (): void => { void this.runtime?.setTyping(accountId, openid, true); };
    tick();
    this.typingTimers.set(key, setInterval(tick, 5_000));
  }
  private stopTyping(accountId: string, openid: string, key: string): void {
    const t = this.typingTimers.get(key);
    if (t) { clearInterval(t); this.typingTimers.delete(key); }
    void this.runtime?.setTyping(accountId, openid, false);
  }

  // ── 微信 Project(~/Tangu/webot)下的会话管理 ──
  /** 列出该用户「微信远程」Project 下的会话(标注哪个是正在连接的)。 */
  async listProjectSessions(userId: string): Promise<Array<{ id: string; title: string; updated_at: any; connected: boolean; agentSlug: string | null }>> {
    const rows = await query<any[]>(
      `SELECT id, title, updated_at, agent_config FROM chat_sessions WHERE user_id = ? AND project_path = ? ORDER BY updated_at DESC`,
      [userId, webotDir()],
    );
    const connected = await this.currentBoundSessionId(userId);
    return rows.map((r) => ({ id: r.id, title: r.title || 'WeChat Remote', updated_at: r.updated_at, connected: r.id === connected, agentSlug: (parseJson(r.agent_config) || {}).agentSlug || null }));
  }

  /** 设置某会话使用的 Normal Agent(merge agentSlug;微信主界面 / desktop 选 agent 用)。 */
  async setSessionAgent(userId: string, sessionId: string, slug: string): Promise<{ ok: boolean }> {
    const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
    if (!rows[0]) throw new Error('Session not found');
    const cfg = parseJson(rows[0].agent_config) || {};
    await deps().state.setAgentConfig(sessionId, JSON.stringify({ ...cfg, agentSlug: slug }));
    return { ok: true };
  }

  /** 当前活跃绑定指向的会话 id(正在连接的 session)。 */
  async currentBoundSessionId(userId: string): Promise<string | null> {
    const rows = await query<any[]>(
      `SELECT session_id FROM tangu_wechat_bindings WHERE user_id = ? AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0]?.session_id ?? null;
  }

  /** 把「正在连接的 session」切换到 sessionId(校验归属;兜底补齐 host+cwd)。 */
  async setConnectedSession(userId: string, sessionId: string): Promise<{ ok: boolean }> {
    const rows = await query<any[]>(`SELECT agent_config, project_path FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
    const s = rows[0];
    if (!s) throw new Error('Session not found');
    if (s.project_path !== webotDir()) throw new Error('只能连接「微信远程」工作区下的会话');
    const cfg = parseJson(s.agent_config) || {};
    if (cfg.execMode !== 'host' || !cfg.cwd) {
      await deps().state.setAgentConfig(sessionId, JSON.stringify({ ...cfg, execMode: 'host', approvalMode: cfg.approvalMode || defaultApprovalMode(), cwd: cfg.cwd || s.project_path || webotDir() }));
    }
    await query(`UPDATE tangu_wechat_bindings SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_active = TRUE`, [sessionId, userId]);
    return { ok: true };
  }

  /**
   * 把一份媒体(图片/文件)发送到某会话当前连接的微信用户。
   * 经会话的活跃绑定解析 account_id + peer_id(openid),再走 runtime.sendMedia。
   * 供 builtin 工具(wechat_send_file / wechat_send_image)调用:工具只有 ctx.userId + ctx.sessionId。
   */
  async sendMediaForSession(
    userId: string,
    sessionId: string,
    buffer: Buffer,
    opts: { kind: 'image' | 'file'; fileName: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const rows = await query<any[]>(
      `SELECT account_id, peer_id FROM tangu_wechat_bindings
       WHERE session_id = ? AND user_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, userId],
    );
    const b = rows[0];
    if (!b) return { ok: false, error: '该会话未连接微信(没有活跃绑定)。请在 Tangu Desktop 的「微信远程」里扫码连接,并把此会话设为正在连接。' };
    if (!b.peer_id) return { ok: false, error: '微信尚未确定联系人。请先让对方在微信里发一条消息,再重试发送。' };
    let runtime: IlinkRuntime;
    try { runtime = await this.ensureRuntime(); }
    catch (e: any) { return { ok: false, error: e?.message || '微信远程服务不可用' }; }
    return runtime.sendMedia(b.account_id, b.peer_id, buffer, opts, signal);
  }

  /** 在「微信远程」Project 下新建一个会话(用于 bot /new 或桌面入口)。 */
  async createWebotSession(userId: string, modelId?: string, title?: string): Promise<string> {
    const ws = await ensureWebotDir();
    const profile = deps().profile;
    const mid = modelId || profile.defaultModelId || '';
    const id = uuidv4();
    await deps().state.autoCreateSession({ id, userId, appId: profile.appId, title: title || 'WeChat Remote', modelId: mid });
    await query(`UPDATE chat_sessions SET project_path = ? WHERE id = ?`, [ws, id]);
    await deps().state.setAgentConfig(id, JSON.stringify({ execMode: 'host', approvalMode: defaultApprovalMode(), cwd: ws, agentSlug: readAgentsMeta().defaultSlug }));
    return id;
  }

  /** 微信 bot slash 命令分发。 */
  private async handleSlash(binding: BindingRow, text: string): Promise<string> {
    const parts = text.slice(1).trim().split(/\s+/);
    const c = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    if (c === 'new' || c === 'n' || c === '新建') {
      const sid = await this.createWebotSession(binding.user_id, undefined, arg || undefined);
      await this.setConnectedSession(binding.user_id, sid);
      return '✓ 已新建会话并切换连接。之后的消息都发往这个新会话。回复 /list 查看全部。';
    }
    if (c === 'list' || c === 'ls' || c === '列表') {
      const items = await this.listProjectSessions(binding.user_id);
      if (!items.length) return '当前还没有会话。回复 /new 新建一个。';
      const lines = items.map((s, i) => `${i + 1}. ${s.connected ? '● ' : ''}${s.title || '未命名'}`);
      return `微信会话(● 为正在连接):\n${lines.join('\n')}\n\n回复 /switch <序号> 切换。`;
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
      const cur = (parseJson(rows[0]?.agent_config) || {}).agentSlug || readAgentsMeta().defaultSlug;
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
        if (on) await setPluginEnabled(VOICE_MESSAGE_PLUGIN_ID, true); // 确保插件启用(WeChat-only 用户也能开)
        await setScopeSettings(VOICE_MESSAGE_PLUGIN_ID, { agentSlug: slug }, { apply: on });
      } catch (e: any) {
        return `切换失败:${e?.message || e}`;
      }
      return on
        ? '✓ 已切到语音消息:之后本会话的回复会以微信语音气泡发出。需先在 Desktop「设置 → 模型 → 语音朗读」配好 TTS 模型;未配则回退发文字。回复 /text 切回文字。'
        : '✓ 已切回文字消息。回复 /voice 再切到语音。';
    }
    if (c === 'help' || c === 'h' || c === '帮助' || c === '?') {
      return ['可用命令:', '/new 新建会话并切换连接', '/list 列出会话(● 为正在连接)', '/switch <序号> 切换正在连接的会话', '/agents 列出可用 Agent', '/agent <slug> 切换本会话的 Agent', '/voice 语音消息 · /text 文字消息', '/help 显示本帮助', '停止 中止当前任务', '批准 / 拒绝 处理待批操作'].join('\n');
    }
    return `未知命令 /${parts[0]}。回复 /help 查看可用命令。`;
  }
}

function parseJson(v: any): any {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

const service = new WechatRemoteService();

export const startWechatRemote = (): Promise<void> => service.start();
export const stopWechatRemote = (): void => service.stop();
export const wechatRemote = service;
