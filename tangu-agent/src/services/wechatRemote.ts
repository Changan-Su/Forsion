/**
 * WeChat Remote 兼容垫片:实现已泛化到 channels/(service.ts 管线 + wechat.ts 驱动 + hub.ts 编排)。
 * 本文件保留旧 API 表面(routes/wechat.ts、builtin 工具、插件 SDK 的既有调用点),内部全部委派 hub。
 *
 * 会话语义(2026-07 起):**连接即新会话**——扫码确认时新建全新会话并绑定,不再有
 * 「默认会话/每用户确定性会话」概念;loginStart 的 session_id/model_id 参数被忽略(仅兼容旧客户端)。
 */
import { query } from '../core/db.js';
import { channelHub } from '../channels/hub.js';
import type { ApprovalMode, SendResult } from '../channels/types.js';
import { channelSettings } from '../channels/config.js';

class WechatRemoteFacade {
  private get service() { return channelHub.service('wechat'); }
  private get driver() { return channelHub.wechatDriver; }

  private async ensureRuntime(): Promise<void> {
    channelHub.ensureAvailable();
    if (!channelSettings('wechat').enabled) throw new Error('WeChat Remote is disabled or unavailable in this profile');
    await channelHub.startChannel('wechat');
  }

  async loginStart(input: { userId: string; sessionId?: string; modelId?: string; approvalMode?: ApprovalMode }): Promise<any> {
    await this.ensureRuntime();
    return this.driver.loginStart({ userId: input.userId, approvalMode: input.approvalMode });
  }

  async loginStatus(userId: string, loginId: string): Promise<any> {
    await this.ensureRuntime();
    return this.driver.loginStatus(this.service, userId, loginId);
  }

  async status(userId: string): Promise<any> {
    if (channelHub.available() && channelSettings('wechat').enabled) {
      await channelHub.startChannel('wechat').catch(() => {});
    }
    const rows = await query<any[]>(
      `SELECT b.id, b.account_id, b.peer_id, b.session_id, b.remote_approval_mode, b.is_active,
              a.status, a.wx_user_id, s.title AS session_title
       FROM tangu_wechat_bindings b
       LEFT JOIN tangu_wechat_accounts a ON a.id = b.account_id
       LEFT JOIN chat_sessions s ON s.id = b.session_id
       WHERE b.user_id = ? AND b.channel = 'wechat'
       ORDER BY b.updated_at DESC`,
      [userId],
    );
    return { enabled: channelSettings('wechat').enabled, runtime: this.driver.status(), bindings: rows };
  }

  async disconnect(userId: string, accountId: string): Promise<any> {
    await this.service.disconnect(userId, accountId);
    await this.driver.removeAccount(accountId);
    return { ok: true };
  }

  listProjectSessions(userId: string) { return this.service.listProjectSessions(userId); }
  setSessionAgent(userId: string, sessionId: string, slug: string) { return this.service.setSessionAgent(userId, sessionId, slug); }
  setConnectedSession(userId: string, sessionId: string) { return this.service.setConnectedSession(userId, sessionId); }
  async currentBoundSessionId(userId: string): Promise<string | null> {
    const b = await this.service.activeBinding(userId);
    return b?.session_id ?? null;
  }
  createWebotSession(userId: string, modelId?: string, title?: string) { return this.service.createChannelSession(userId, modelId, title); }

  /** 通道通用:按会话反查活跃绑定(任意通道)并发送媒体(builtin 工具/插件 SDK 调用点)。 */
  sendMediaForSession(userId: string, sessionId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult> {
    return channelHub.sendMediaForSession(userId, sessionId, buffer, opts, signal);
  }
}

export const wechatRemote = new WechatRemoteFacade();
