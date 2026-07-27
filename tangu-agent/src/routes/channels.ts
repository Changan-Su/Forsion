/**
 * 多通道路由:设置读写 / 连接与断开 / 会话新建。微信扫码仍走 routes/wechat.ts(QR 流程特有)。
 * host-only:云端 profile 调用返回 500(与 WeChat Remote 历史行为一致,门禁在服务层)。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { channelHub } from '../channels/hub.js';
import { CHANNEL_KINDS, type ChannelKind, type ChannelSettings } from '../channels/types.js';

const router = Router();

function kindOf(v: any): ChannelKind {
  if (!CHANNEL_KINDS.includes(v)) throw new Error(`unknown channel: ${v}`);
  return v as ChannelKind;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

/** 从请求 body 提取允许的设置键(白名单;secrets 传空串 = 清除)。 */
function settingsPatch(body: any): Partial<ChannelSettings> {
  const patch: Partial<ChannelSettings> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.sessions === 'boolean') patch.sessions = body.sessions;
  for (const k of ['agentSlug', 'modelId', 'imageModelId', 'ttsModelId', 'ttsVoice', 'botToken', 'appId', 'appSecret'] as const) {
    const v = str(body[k]);
    if (v !== undefined) (patch as any)[k] = v;
  }
  const am = body.approvalMode;
  if (am === 'readonly' || am === 'auto-edit' || am === 'full-auto') patch.approvalMode = am;
  if (body.inboxForward && typeof body.inboxForward === 'object') {
    const senders = body.inboxForward.senders;
    patch.inboxForward = {
      enabled: body.inboxForward.enabled === true,
      senders: senders === 'all' || !Array.isArray(senders) ? 'all' : senders.map((s: any) => String(s)).filter(Boolean),
    };
  }
  return patch;
}

router.get('/agent/channels', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json({ available: channelHub.available(), channels: await channelHub.statusAll(req.user!.userId) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'channels status failed' });
  }
});

router.put('/agent/channels/:kind/config', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const kind = kindOf(req.params.kind);
    const settings = await channelHub.applySettings(kind, settingsPatch(req.body || {}));
    const { botToken, appSecret, ...safe } = settings;
    res.json({ ok: true, settings: { ...safe, botTokenSet: !!botToken, appSecretSet: !!appSecret } });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'channel config failed' });
  }
});

/**
 * 连接通道(telegram/qq:校验凭据 → 启动 → **新建全新会话**并绑定;连接即新会话)。
 * 微信走 /agent/wechat/login/*(扫码)。
 */
router.post('/agent/channels/:kind/connect', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const kind = kindOf(req.params.kind);
    channelHub.ensureAvailable();
    if (kind === 'wechat') return res.status(400).json({ detail: '微信请使用扫码连接(/agent/wechat/login/start)' });
    const svc = channelHub.service(kind);
    let accountId = '';
    let label = '';
    if (kind === 'telegram') {
      const me = await channelHub.telegramDriver.verify();
      accountId = `tg:${me.id}`;
      label = me.username ? `@${me.username}` : String(me.id);
    } else {
      const me = await channelHub.qqDriver.verify();
      accountId = channelHub.qqDriver.status()[0]?.accountId || 'qq:bot';
      label = me.username;
    }
    // 先绑定(连接即新会话),再确保运行时在跑。peer 留空 → 第一个来消息的 peer 认领(TOFU)。
    const { sessionId } = await svc.bindAccount({ userId: req.user!.userId, accountId, label });
    await channelHub.applySettings(kind, { enabled: true });
    res.json({ ok: true, accountId, label, sessionId });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'channel connect failed' });
  }
});

router.post('/agent/channels/:kind/disconnect', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const kind = kindOf(req.params.kind);
    const svc = channelHub.service(kind);
    const accountId = str(req.body?.account_id);
    await svc.disconnect(req.user!.userId, accountId || undefined);
    if (kind === 'wechat' && accountId) await channelHub.wechatDriver.removeAccount(accountId);
    else channelHub.stopChannel(kind);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'channel disconnect failed' });
  }
});

/** 把某会话切为该通道「正在连接」的会话(校验须在通道工作区下)。 */
router.post('/agent/channels/:kind/connect-session', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const kind = kindOf(req.params.kind);
    const sessionId = str(req.body?.session_id);
    if (!sessionId) return res.status(400).json({ detail: 'session_id is required' });
    res.json(await channelHub.service(kind).setConnectedSession(req.user!.userId, sessionId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'channel connect-session failed' });
  }
});

/** 在通道工作区新建会话(可选立即切为正在连接;desktop / bot 均可用)。 */
router.post('/agent/channels/:kind/sessions/new', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const kind = kindOf(req.params.kind);
    channelHub.ensureAvailable();
    const svc = channelHub.service(kind);
    const id = await svc.createChannelSession(req.user!.userId, str(req.body?.model_id), str(req.body?.title));
    if (req.body?.connect !== false) await svc.setConnectedSession(req.user!.userId, id);
    res.json({ sessionId: id });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'channel session create failed' });
  }
});

export default router;
