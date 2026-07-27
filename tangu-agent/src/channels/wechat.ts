/**
 * 微信通道驱动:iLink bot(扫码登录 + 长轮询,复用 wechat/ilinkClient·ilinkRuntime)。
 * token 留在 stateDir/accounts.json,数据库只记录 account/session/peer 绑定。
 */
import { randomUUID } from 'node:crypto';
import { IlinkClient, ILINK_BASE_URL } from '../wechat/ilinkClient.js';
import { IlinkRuntime } from '../wechat/ilinkRuntime.js';
import { query } from '../core/db.js';
import { wechatStateDir } from './config.js';
import type { ApprovalMode, ChannelDriver, ChannelInbound, SendResult } from './types.js';
import type { ChannelService } from './service.js';

const LOGIN_TTL_MS = 8 * 60_000;

interface PendingLogin {
  userId: string;
  approvalMode?: ApprovalMode;
  qrcode: string;
  baseUrl: string;
  expiresAt: number;
}

export class WechatChannel implements ChannelDriver {
  readonly kind = 'wechat' as const;
  private runtime: IlinkRuntime | null = null;
  private started = false;
  private readonly pending = new Map<string, PendingLogin>();
  // confirmed 后的建号+建会话单飞:桌面 2s 轮询可能并发出两个 confirmed,不单飞会建出两个会话/绑定。
  private readonly confirming = new Map<string, Promise<any>>();

  async start(onMessage: (msg: ChannelInbound) => Promise<string>): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.runtime = new IlinkRuntime({
      stateDir: wechatStateDir(),
      onMessage: (m) => onMessage({ accountId: m.accountId, peerId: m.openid, text: m.text, messageId: m.messageId, attachments: m.attachments, files: m.files }),
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
    this.confirming.clear();
  }

  status(): Array<{ accountId: string; running: boolean; peers?: number; label?: string }> {
    return this.runtime?.status() || [];
  }

  send(accountId: string, peerId: string, text: string): Promise<SendResult> {
    if (!this.runtime) return Promise.resolve({ ok: false, error: 'wechat runtime not started' });
    return this.runtime.send(accountId, peerId, text);
  }

  sendMedia(accountId: string, peerId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult> {
    if (!this.runtime) return Promise.resolve({ ok: false, error: 'wechat runtime not started' });
    return this.runtime.sendMedia(accountId, peerId, buffer, opts, signal);
  }

  async setTyping(accountId: string, peerId: string, on: boolean): Promise<void> {
    await this.runtime?.setTyping(accountId, peerId, on);
  }

  // ── 扫码登录(微信特有) ──

  private ensureRuntime(): IlinkRuntime {
    if (!this.runtime) throw new Error('WeChat channel is disabled or unavailable in this profile');
    return this.runtime;
  }

  async loginStart(input: { userId: string; approvalMode?: ApprovalMode }): Promise<any> {
    this.ensureRuntime();
    const { qrcode, qrcodeImg } = await IlinkClient.qrStart();
    if (!qrcode || !qrcodeImg) throw new Error('iLink QR start failed');
    const loginId = randomUUID();
    this.pending.set(loginId, {
      userId: input.userId,
      approvalMode: input.approvalMode,
      qrcode,
      baseUrl: ILINK_BASE_URL,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    this.prunePending();
    return { loginId, qrcode, qrcodeImg, expiresAt: Date.now() + LOGIN_TTL_MS };
  }

  /** 轮询扫码状态;confirmed 时登记账号 + **新建全新会话**并绑定(连接即新会话)。 */
  async loginStatus(service: ChannelService, userId: string, loginId: string): Promise<any> {
    // 已有确认流程在跑(或刚成功) → 复用同一结果,不重复建号/建会话。
    const inflight = this.confirming.get(loginId);
    if (inflight) return inflight;
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

    // 单飞:并发轮询(qrStatus await 期间又进来一个 confirmed)只允许一次落库。
    // 检查+登记在同一同步段完成(async 体首个 await 前不让出),无竞态窗口。
    const again = this.confirming.get(loginId);
    if (again) return again;
    const task = (async () => {
      const runtime = this.ensureRuntime();
      await runtime.addAccount({ accountId: st.accountId!, token: st.token!, baseUrl: st.baseUrl || p.baseUrl });
      const { sessionId } = await service.bindAccount({
        userId,
        accountId: st.accountId!,
        peerId: st.userId || null,
        label: st.userId || null,
        approvalMode: p.approvalMode,
      });
      this.pending.delete(loginId);
      return { status: 'confirmed', accountId: st.accountId, sessionId };
    })();
    this.confirming.set(loginId, task);
    task.then(
      () => { setTimeout(() => this.confirming.delete(loginId), 60_000); }, // 成功:留 60s 给迟到轮询复用
      () => { this.confirming.delete(loginId); }, // 失败:立即清,允许下轮重试
    );
    return task;
  }

  async removeAccount(accountId: string): Promise<void> {
    await this.runtime?.removeAccount(accountId);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }
}
