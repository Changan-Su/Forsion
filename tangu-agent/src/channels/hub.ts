/**
 * ChannelHub:三通道(微信/Telegram/QQ)的注册表与生命周期编排 + 收件箱转发。
 * host/standalone-only(闸门 = profile.capabilities.hostExec,与 WeChat Remote 历史一致)。
 */
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { ChannelService } from './service.js';
import { WechatChannel } from './wechat.js';
import { TelegramChannel } from './telegram.js';
import { QQChannel } from './qq.js';
import { channelSettings, saveChannelSettings } from './config.js';
import type { ChannelKind, ChannelSettings, SendResult } from './types.js';
import { CHANNEL_KINDS } from './types.js';

class ChannelHub {
  readonly wechatDriver = new WechatChannel();
  readonly telegramDriver = new TelegramChannel();
  readonly qqDriver = new QQChannel();
  private readonly services = new Map<ChannelKind, ChannelService>();
  private started = false;

  constructor() {
    this.services.set('wechat', new ChannelService({
      kind: 'wechat',
      driver: this.wechatDriver,
      unboundHint: '这个微信账号尚未绑定 Tangu Agent,请先在 Tangu Desktop 设置里扫码连接。',
      inboxDirName: 'wechat-inbox', // 历史目录名,勿改
      sessionTitle: 'WeChat Remote',
    }));
    this.services.set('telegram', new ChannelService({
      kind: 'telegram',
      driver: this.telegramDriver,
      unboundHint: 'This Telegram chat is not bound to Tangu Agent yet. Connect it in Tangu Desktop → Settings → Channels first.',
      inboxDirName: 'telegram-inbox',
      sessionTitle: 'Telegram',
    }));
    this.services.set('qq', new ChannelService({
      kind: 'qq',
      driver: this.qqDriver,
      unboundHint: '这个 QQ 尚未绑定 Tangu Agent,请先在 Tangu Desktop 设置里连接通道。',
      inboxDirName: 'qq-inbox',
      sessionTitle: 'QQ',
    }));
  }

  available(): boolean { return !!deps().profile.capabilities.hostExec; }

  ensureAvailable(): void {
    if (!this.available()) throw new Error('Channels are disabled or unavailable in this profile');
  }

  service(kind: string): ChannelService {
    const s = this.services.get(kind as ChannelKind);
    if (!s) throw new Error(`unknown channel: ${kind}`);
    return s;
  }

  /** 启动所有已启用通道(引擎启动时调用;云端 profile no-op)。 */
  async startAll(): Promise<void> {
    if (this.started || !this.available()) return;
    this.started = true;
    for (const kind of CHANNEL_KINDS) {
      if (channelSettings(kind).enabled) {
        await this.startChannel(kind).catch((e: any) => console.warn(`[channels] ${kind} 启动失败:`, e?.message || e));
      }
    }
  }

  stopAll(): void {
    for (const kind of CHANNEL_KINDS) this.stopChannel(kind);
    this.started = false;
  }

  async startChannel(kind: ChannelKind): Promise<void> {
    this.ensureAvailable();
    const svc = this.service(kind);
    await svc.driver.start((msg) => svc.handleInbound(msg));
  }

  stopChannel(kind: ChannelKind): void {
    const svc = this.services.get(kind);
    if (!svc) return;
    svc.driver.stop();
    svc.releasePending();
  }

  /**
   * 应用设置变更:保存 + 热生效(enabled 切换 → 启停;凭据变更且在跑 → 重启该通道)。
   */
  async applySettings(kind: ChannelKind, patch: Partial<ChannelSettings>): Promise<ChannelSettings> {
    const before = channelSettings(kind);
    const after = saveChannelSettings(kind, patch);
    if (!this.available()) return after;
    const credsChanged = (patch.botToken !== undefined && patch.botToken !== before.botToken)
      || (patch.appId !== undefined && patch.appId !== before.appId)
      || (patch.appSecret !== undefined && patch.appSecret !== before.appSecret);
    if (!after.enabled) {
      this.stopChannel(kind);
    } else if (!before.enabled || credsChanged) {
      this.stopChannel(kind);
      await this.startChannel(kind).catch((e: any) => console.warn(`[channels] ${kind} 启动失败:`, e?.message || e));
    }
    return after;
  }

  /** 各通道状态汇总(供设置 UI;secrets 不回显,只给布尔)。 */
  async statusAll(userId: string): Promise<any[]> {
    const out: any[] = [];
    for (const kind of CHANNEL_KINDS) {
      const svc = this.service(kind);
      const st = channelSettings(kind);
      const binding = await svc.activeBinding(userId).catch(() => null);
      out.push({
        kind,
        enabled: st.enabled,
        sessions: st.sessions,
        agentSlug: st.agentSlug,
        modelId: st.modelId,
        imageModelId: st.imageModelId,
        ttsModelId: st.ttsModelId,
        ttsVoice: st.ttsVoice,
        approvalMode: st.approvalMode,
        inboxForward: st.inboxForward,
        credentials: {
          botTokenSet: !!st.botToken,
          appIdSet: !!st.appId,
          appSecretSet: !!st.appSecret,
          appId: st.appId || '',
        },
        runtime: svc.driver.status(),
        connectedSessionId: binding?.session_id || null,
        // 活跃绑定的账号 id:断开连接必须用它(iLink 可存多账号,runtime[0] 未必是活跃绑定那个)。
        accountId: binding?.account_id || null,
        peerBound: !!binding?.peer_id,
        workspace: svc.workspaceDir(),
      });
    }
    return out;
  }

  /**
   * 把媒体发到某会话所连接的通道 peer(builtin 工具/插件 SDK 用)。
   * 按 session 反查活跃绑定的 channel,再委派对应通道。
   */
  async sendMediaForSession(userId: string, sessionId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult> {
    const rows = await query<any[]>(
      `SELECT channel FROM tangu_wechat_bindings WHERE session_id = ? AND user_id = ? AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, userId],
    );
    const kind = (rows[0]?.channel || '') as ChannelKind;
    if (!kind || !this.services.has(kind)) {
      return { ok: false, error: '该会话未连接任何通道(没有活跃绑定)。请先在 Tangu Desktop 设置里连接通道,并把此会话设为正在连接。' };
    }
    return this.service(kind).sendMediaForSession(userId, sessionId, buffer, opts, signal);
  }

  /** 本会话是否连接着某个通道(有活跃绑定)——工具门禁用(channel_send_* 只在通道会话暴露)。失败 → false。 */
  async isChannelSession(userId: string, sessionId: string): Promise<boolean> {
    if (!this.available()) return false;
    try {
      const rows = await query<any[]>(
        `SELECT 1 AS one FROM tangu_wechat_bindings WHERE session_id = ? AND user_id = ? AND is_active = TRUE LIMIT 1`,
        [sessionId, userId],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 收件箱转发:把一条收件箱消息推送到所有「已启用 + 开了转发 + 发件人在允许名单」的通道。
   * 与 Channel Session 完全独立(sessions 关闭也照转)。fire-and-forget,失败只记日志。
   */
  forwardInbox(input: { userId: string; title: string; body?: string; senderKind: 'agent' | 'system' | 'server'; senderId?: string }): void {
    if (!this.available()) return;
    const senderKey = input.senderKind === 'agent' ? (input.senderId || '') : input.senderKind;
    const text = [`📥 ${input.title}`, (input.body || '').trim()].filter(Boolean).join('\n\n').slice(0, 3500);
    for (const kind of CHANNEL_KINDS) {
      const st = channelSettings(kind);
      if (!st.enabled || !st.inboxForward.enabled) continue;
      if (st.inboxForward.senders !== 'all' && !st.inboxForward.senders.includes(senderKey)) continue;
      const svc = this.service(kind);
      void svc.sendToOwner(input.userId, text).then((r) => {
        if (!r.ok) console.warn(`[channels] inbox 转发到 ${kind} 失败:`, r.error);
      }).catch((e: any) => console.warn(`[channels] inbox 转发到 ${kind} 失败:`, e?.message || e));
    }
  }
}

export const channelHub = new ChannelHub();

export async function startChannels(): Promise<void> {
  await channelHub.startAll();
}

export function stopChannels(): void {
  channelHub.stopAll();
}
