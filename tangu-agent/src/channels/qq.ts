/**
 * QQ 通道驱动:QQ 开放平台官方 v2 API(AppID+AppSecret),WS 网关收消息 + REST 发消息。
 * 协议参考 openhanako qq-adapter(官方路线,非 OneBot/NapCat)。
 * 要点:
 *  - 收:GET /gateway 拿 wss → HELLO→IDENTIFY(intents GROUP_AND_C2C)→DISPATCH(C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE)
 *  - 发:被动回复需带入站 msg_id + 递增 msg_seq(时效 ~5 分钟、每条上限 5 次);超出即主动消息,受平台配额/审核限制,失败如实上报。
 *  - 媒体:两步(POST /v2/.../files {file_type,file_data} → file_info → msg_type:7);群聊不开放 file_type 4(文件)。
 * peerId 编码:`c2c:<openid>` 私聊 / `group:<group_openid>` 群聊。
 */
import WebSocket from 'ws';
import { channelSettings } from './config.js';
import type { ChannelDriver, ChannelInbound, InboundFile, InboundImage, SendResult } from './types.js';

const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;
const INTENT_GROUP_AND_C2C = 1 << 25;
const MAX_TEXT_LEN = 2000;
const MEDIA_MAX_BYTES = 8 * 1024 * 1024; // file_data base64 上传的保守上限
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
// 被动回复窗口:入站 msg_id 约 5 分钟内可回,每条最多 5 次(官方限制)。
const REPLY_TTL_MS = 4.5 * 60_000;
const REPLY_MAX_SEQ = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class QQChannel implements ChannelDriver {
  readonly kind = 'qq' as const;
  private running = false;
  // 代际号:stop()/换凭据重启使旧 WS 的事件回调与重连计划全部失效(防双连接/旧 token 复用)。
  private gen = 0;
  private ws: WebSocket | null = null;
  private accessToken = '';
  private tokenExpiresAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAck = true;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private lastConnectedAt = 0;
  private connected = false;
  private botLabel = '';
  private onMessage: ((msg: ChannelInbound) => Promise<string>) | null = null;
  // 被动回复上下文:peer → 最近入站消息 {msgId, seq, at}。
  private readonly replyCtx = new Map<string, { msgId: string; seq: number; at: number }>();
  private sendChain = Promise.resolve();

  private creds(): { appId: string; appSecret: string } {
    const st = channelSettings('qq');
    return { appId: st.appId || '', appSecret: st.appSecret || '' };
  }
  private accountId(): string { return `qq:${this.creds().appId || 'bot'}`; }

  // ── token / REST ──
  private async refreshToken(): Promise<string> {
    const { appId, appSecret } = this.creds();
    if (!appId || !appSecret) throw new Error('QQ AppID/AppSecret 未配置');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!data.access_token) throw new Error(`QQ getAppAccessToken failed: ${JSON.stringify(data).slice(0, 200)}`);
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000;
    return this.accessToken;
  }

  private async getToken(): Promise<string> {
    if (!this.accessToken || Date.now() > this.tokenExpiresAt - 5 * 60_000) return this.refreshToken();
    return this.accessToken;
  }

  private async api<T = any>(method: string, apiPath: string, body?: any): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${API_BASE}${apiPath}`, {
      method,
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let message = text;
      try { const p = JSON.parse(text); message = p.message || p.msg || text; } catch { /* raw */ }
      throw new Error(`QQ API [${apiPath}] ${res.status}: ${String(message).slice(0, 200)}`);
    }
    if (!text.trim()) return {} as T;
    try { return JSON.parse(text) as T; } catch { throw new Error(`QQ API [${apiPath}] invalid JSON`); }
  }

  /** 校验凭据(取 token + bot 身份)。 */
  async verify(): Promise<{ username: string }> {
    await this.refreshToken();
    const me = await this.api<any>('GET', '/users/@me').catch(() => null);
    this.botLabel = me?.username || this.creds().appId;
    return { username: this.botLabel };
  }

  // ── 生命周期 ──
  async start(onMessage: (msg: ChannelInbound) => Promise<string>): Promise<void> {
    if (this.running) return;
    const { appId, appSecret } = this.creds();
    if (!appId || !appSecret) return;
    this.onMessage = onMessage;
    this.running = true;
    void this.connect(this.gen);
  }

  stop(): void {
    this.running = false;
    this.gen += 1; // 作废在飞连接/重连计划/旧 WS 回调
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    this.connected = false;
    // 凭据可能已更换:作废缓存 token 与 WS 会话恢复状态(避免下次 start 用旧 app 的 token/RESUME)。
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.sessionId = null;
    this.lastSeq = null;
    this.reconnectAttempts = 0;
    if (this.ws) { try { this.ws.close(); } catch { /* noop */ } this.ws = null; }
  }

  status(): Array<{ accountId: string; running: boolean; label?: string }> {
    const { appId, appSecret } = this.creds();
    if (!appId || !appSecret) return [];
    return [{ accountId: this.accountId(), running: this.running && this.connected, label: this.botLabel || undefined }];
  }

  private async connect(gen: number): Promise<void> {
    if (!this.running || gen !== this.gen) return;
    try {
      const token = await this.getToken();
      const { url } = await this.api<any>('GET', '/gateway');
      if (!url) throw new Error('QQ gateway url missing');
      if (!this.running || gen !== this.gen) return; // 取网关期间被 stop/换代
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('open', () => {
        if (gen !== this.gen) { try { ws.close(); } catch { /* noop */ } return; }
        this.lastConnectedAt = Date.now();
        this.reconnectAttempts = 0;
      });
      ws.on('message', (raw: any) => {
        if (gen !== this.gen) return; // 旧代 WS 的迟到消息不处理
        let payload: any;
        try { payload = JSON.parse(String(raw)); } catch { return; }
        this.handlePayload(payload, token);
      });
      ws.on('close', () => {
        if (gen !== this.gen) return; // 旧代 WS 的迟到 close 不得再排重连
        this.stopHeartbeat();
        this.connected = false;
        if (this.running) this.scheduleReconnect(gen);
      });
      ws.on('error', (err: any) => {
        console.warn('[qq-channel] WebSocket error:', err?.message || err);
      });
    } catch (e: any) {
      console.warn('[qq-channel] connect failed:', e?.message || e);
      if (this.running && gen === this.gen) this.scheduleReconnect(gen);
    }
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || gen !== this.gen || this.reconnectTimer) return;
    if (this.lastConnectedAt && Date.now() - this.lastConnectedAt > 5 * 60_000) this.reconnectAttempts = 0;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(gen); }, delay);
  }

  private wsSend(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.heartbeatAck = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAck) { try { this.ws?.close(); } catch { /* noop */ } return; } // 心跳无 ACK → 强制重连
      this.heartbeatAck = false;
      this.wsSend({ op: OP.HEARTBEAT, d: this.lastSeq });
    }, Math.max(interval, 5_000));
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private handlePayload(payload: any, token: string): void {
    const { op, d, s, t } = payload || {};
    if (s) this.lastSeq = s;
    switch (op) {
      case OP.HELLO:
        this.startHeartbeat(Number(d?.heartbeat_interval) || 30_000);
        if (this.sessionId) this.wsSend({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } });
        else this.wsSend({ op: OP.IDENTIFY, d: { token: `QQBot ${token}`, intents: INTENT_GROUP_AND_C2C, shard: [0, 1] } });
        break;
      case OP.DISPATCH:
        if (t === 'READY') { this.sessionId = d?.session_id || null; this.connected = true; this.botLabel = d?.user?.username || this.botLabel; }
        else if (t === 'RESUMED') { this.connected = true; }
        else void this.handleEvent(t, d);
        break;
      case OP.HEARTBEAT_ACK:
        this.heartbeatAck = true;
        break;
      case OP.RECONNECT:
        try { this.ws?.close(); } catch { /* noop */ }
        break;
      case OP.INVALID_SESSION:
        this.sessionId = null;
        this.lastSeq = null;
        try { this.ws?.close(); } catch { /* noop */ }
        break;
      default:
        break;
    }
  }

  private async downloadAttachments(data: any): Promise<{ attachments: InboundImage[]; files: InboundFile[]; lost: number }> {
    const attachments: InboundImage[] = [];
    const files: InboundFile[] = [];
    let lost = 0;
    for (const att of data?.attachments || []) {
      const url = String(att?.url || '');
      if (!url) { lost += 1; continue; }
      try {
        const full = url.startsWith('http') ? url : `https://${url}`;
        const res = await fetch(full, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = String(att?.content_type || '');
        if (ct.startsWith('image/')) attachments.push({ name: String(att?.filename || 'qq-image'), mimeType: ct, data: buf.toString('base64') });
        else files.push({ name: String(att?.filename || 'qq-file'), mimeType: ct || 'application/octet-stream', buffer: buf });
      } catch {
        lost += 1;
      }
    }
    return { attachments, files, lost };
  }

  private async handleEvent(type: string, data: any): Promise<void> {
    let peerId = '';
    let text = '';
    if (type === 'C2C_MESSAGE_CREATE') {
      const openid = data?.author?.user_openid || data?.author?.id;
      if (!openid) return;
      peerId = `c2c:${openid}`;
      text = String(data?.content || '').trim();
    } else if (type === 'GROUP_AT_MESSAGE_CREATE') {
      const gid = data?.group_openid;
      if (!gid) return;
      peerId = `group:${gid}`;
      text = String(data?.content || '').replace(/<@!?\w+>/g, '').trim();
    } else {
      return;
    }
    const { attachments, files, lost } = await this.downloadAttachments(data);
    if (lost > 0) text = [text, `(用户随消息发来 ${lost} 个附件,但读取失败,请告知用户)`].filter(Boolean).join('\n');
    if (!text && !attachments.length && !files.length) return;
    // 登记被动回复上下文(新入站消息重置 seq)。
    if (data?.id) this.replyCtx.set(peerId, { msgId: String(data.id), seq: 0, at: Date.now() });
    const reply = await this.onMessage?.({ accountId: this.accountId(), peerId, text, messageId: data?.id ? String(data.id) : undefined, attachments: attachments.length ? attachments : undefined, files: files.length ? files : undefined });
    if (reply) await this.send(this.accountId(), peerId, reply);
  }

  // ── 出站 ──
  private endpoints(peerId: string, resource: 'messages' | 'files'): string {
    const [kind, id] = peerId.includes(':') ? [peerId.slice(0, peerId.indexOf(':')), peerId.slice(peerId.indexOf(':') + 1)] : ['c2c', peerId];
    return kind === 'group' ? `/v2/groups/${id}/${resource}` : `/v2/users/${id}/${resource}`;
  }

  /** 组装被动回复字段(窗口内且未超次数);超出则按主动消息发(可能受平台配额限制)。 */
  private passiveFields(peerId: string): { msg_id?: string; msg_seq?: number } {
    const ctx = this.replyCtx.get(peerId);
    if (!ctx || Date.now() - ctx.at > REPLY_TTL_MS || ctx.seq >= REPLY_MAX_SEQ) return {};
    ctx.seq += 1;
    return { msg_id: ctx.msgId, msg_seq: ctx.seq };
  }

  private paced<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => { await sleep(300); return fn(); };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.then(() => {}, () => {});
    return p;
  }

  async send(_accountId: string, peerId: string, text: string): Promise<SendResult> {
    try {
      for (let i = 0; i < text.length; i += MAX_TEXT_LEN) {
        const chunk = text.slice(i, i + MAX_TEXT_LEN);
        await this.paced(() => this.api('POST', this.endpoints(peerId, 'messages'), { content: chunk, msg_type: 0, ...this.passiveFields(peerId) }));
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async sendMedia(_accountId: string, peerId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }): Promise<SendResult> {
    try {
      if (buffer.length > MEDIA_MAX_BYTES) return { ok: false, error: `QQ 媒体过大(${buffer.length}B > ${MEDIA_MAX_BYTES}B)` };
      const isGroup = peerId.startsWith('group:');
      const fileType = opts.kind === 'image' ? 1 : 4;
      if (isGroup && fileType === 4) return { ok: false, error: 'QQ 群聊暂不开放文件类型发送(仅图片/视频/语音)。' };
      const up = await this.paced(() => this.api<any>('POST', this.endpoints(peerId, 'files'), { file_type: fileType, srv_send_msg: false, file_data: buffer.toString('base64') }));
      if (!up?.file_info) return { ok: false, error: 'QQ 媒体上传未返回 file_info' };
      await this.paced(() => this.api('POST', this.endpoints(peerId, 'messages'), { msg_type: 7, media: { file_info: up.file_info }, content: ' ', ...this.passiveFields(peerId) }));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}
