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
import { channelHasCredentials, channelSettings, saveChannelSettings } from './config.js';
import type { ChannelKind, ChannelSettings, SendResult } from './types.js';
import { CHANNEL_KINDS } from './types.js';

class ChannelHub {
  readonly wechatDriver = new WechatChannel();
  readonly telegramDriver = new TelegramChannel();
  readonly qqDriver = new QQChannel();
  private readonly services = new Map<ChannelKind, ChannelService>();
  private started = false;

  constructor() {
    // 未绑定提示按通道语言从 messages.ts 取(service 内部),这里不再写死中文 / 英文。
    this.services.set('wechat', new ChannelService({
      kind: 'wechat',
      driver: this.wechatDriver,
      inboxDirName: 'wechat-inbox', // 历史目录名,勿改
      sessionTitle: 'WeChat Remote',
    }));
    this.services.set('telegram', new ChannelService({
      kind: 'telegram',
      driver: this.telegramDriver,
      inboxDirName: 'telegram-inbox',
      sessionTitle: 'Telegram',
    }));
    this.services.set('qq', new ChannelService({
      kind: 'qq',
      driver: this.qqDriver,
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
      // 修复前改过审批档的老绑定还停在旧档(只在建绑定时写过一次):启动时按设置对齐一次 —— 只收紧不放宽。
      // 启动不是用户动作,设置值还可能来自兜底链(微信 legacy env / 旧段 / 缺省 auto-edit),不能借它把老绑定放宽。
      await this.service(kind).syncApprovalMode(channelSettings(kind).approvalMode, { narrowOnly: true })
        .catch((e: any) => console.warn(`[channels] ${kind} 审批档同步失败:`, e?.message || e));
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
    // receive 立即返回 '':入站按 peer 串行分派后放手,run 回复经 driver.send 推送 —— 不占住驱动的轮询循环
    // (微信 / Telegram 的轮询都 await 这个回调;旧版 await 到 run 出第一条回复,期间的「停止」/status 读不到)。
    await svc.driver.start((msg) => svc.receive(msg));
  }

  /** 通道**完全停止**(禁用 / 断开 / 引擎退出):停传输层 + 兑现并释放全部挂起(待批审批按拒绝、询问答「通道已停止」)。 */
  stopChannel(kind: ChannelKind): void {
    const svc = this.services.get(kind);
    if (!svc) return;
    svc.driver.stop();
    svc.releasePending();
  }

  /**
   * 只重启传输层(换凭据 / 启用):**不** releasePending。service 实例常驻、驱动是同一个对象,run 订阅、待答卡片、
   * 回复出口都留着,答复与结果照样经重启后的驱动走。旧版这里走 stopChannel,退订全部 run:在等 ask_user / 计划审阅的
   * run 永远等下去,用户随后的答复被当成新任务,在跑任务的结果也丢了。启动失败只记日志(卡片仍可在桌面端作答,审批照常超时)。
   */
  async restartChannel(kind: ChannelKind): Promise<void> {
    this.ensureAvailable();
    this.service(kind).driver.stop();
    await this.startChannel(kind);
  }

  /**
   * 应用设置变更:保存 + 热生效(enabled 关 / 凭据清空 → 完全停止;开启 / 凭据变更 → 重启传输层;
   * 审批档 → 同步到该通道全部绑定,已连接的会话下一条消息起就按新档)。
   */
  async applySettings(kind: ChannelKind, patch: Partial<ChannelSettings>): Promise<ChannelSettings> {
    const before = channelSettings(kind);
    const after = saveChannelSettings(kind, patch);
    if (!this.available()) return after;
    // 同步失败不挡后面的启停:通道 run 按「设置与绑定取更严」定档(service.channelRunApprovalMode),收紧已经生效;
    // 放宽要等下次同步成功。失败必须留痕 —— 否则用户放宽了档却一直按旧档问,无从查起。
    if (patch.approvalMode !== undefined) {
      await this.service(kind).syncApprovalMode(after.approvalMode)
        .catch((e: any) => console.warn(`[channels] ${kind} 审批档同步到绑定失败(通道 run 仍按设置与绑定中更严的一档跑;放宽要等下次同步成功):`, e?.message || e));
    }
    const credsChanged = (patch.botToken !== undefined && patch.botToken !== before.botToken)
      || (patch.appId !== undefined && patch.appId !== before.appId)
      || (patch.appSecret !== undefined && patch.appSecret !== before.appSecret);
    // 凭据被清空 = 完全停止,不是重启:驱动 start 见不到凭据直接早退(传输层就此停着),不 releasePending 的话
    // 挂着的询问永远等、审批要干等 10 分钟才超时拒绝、run 的结果无处可发。
    if (!after.enabled || (credsChanged && !channelHasCredentials(kind, after))) {
      this.stopChannel(kind);
    } else if (!before.enabled || credsChanged) {
      await this.restartChannel(kind).catch((e: any) => console.warn(`[channels] ${kind} 启动失败:`, e?.message || e));
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
        locale: st.locale ?? null,
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
      return { ok: false, error: 'This session is not connected to any channel (no active binding). The user must connect a channel in Tangu Desktop settings and make this the connected session.' };
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
