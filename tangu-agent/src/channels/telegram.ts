/**
 * Telegram 通道驱动:Bot API 长轮询(getUpdates),零外部依赖(fetch/FormData)。
 * 凭据 = @BotFather 的 bot token(config.json channels.telegram.botToken)。
 * ponytail: 纯文本发送(不设 parse_mode)——MarkdownV2 逃逸矩阵复杂且失败即 400 丢消息;
 * 需要富文本时再引入 markdown→MarkdownV2 转换。
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { tanguHome } from '../core/tanguHome.js';
import { channelSettings } from './config.js';
import type { ChannelDriver, ChannelInbound, InboundFile, InboundImage, SendResult } from './types.js';

const TG_API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 30;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
// Telegram 限制:同一 chat ~1 msg/s。同 chat 串行 + 最小间隔,429 按 retry_after 退避。
const MIN_SEND_INTERVAL_MS = 1_100;
const MAX_TEXT_LEN = 4096; // Telegram 上限(UTF-16 code unit;JS String.length 同单位)
const MAX_FILE_BYTES = 19 * 1024 * 1024; // Bot API getFile 下载上限 20MB,留余量

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TelegramChannel implements ChannelDriver {
  readonly kind = 'telegram' as const;
  private running = false;
  // 代际号:stop()/热重启使旧长轮询循环失效(否则旧循环撞见 running 又变 true 会双循环并发拉取)。
  private gen = 0;
  private offset = 0;
  private botId = 0;
  private botLabel = '';
  private onMessage: ((msg: ChannelInbound) => Promise<string>) | null = null;
  private sendChain = Promise.resolve();
  private readonly lastSentAt = new Map<string, number>();

  private stateFile(): string { return path.join(tanguHome(), 'channels', 'telegram.state.json'); }
  private token(): string { return channelSettings('telegram').botToken || ''; }
  private accountId(): string { return this.botId ? `tg:${this.botId}` : 'tg'; }

  private async api<T = any>(method: string, params?: Record<string, any>, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${TG_API}/bot${this.token()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err: any = new Error(`telegram ${method} failed: ${data.description || res.status}`);
      err.retryAfter = data?.parameters?.retry_after;
      throw err;
    }
    return data.result as T;
  }

  /** 校验 token 并返回 bot 身份(连接前调用)。 */
  async verify(): Promise<{ id: number; username: string }> {
    if (!this.token()) throw new Error('Telegram bot token 未配置');
    const me = await this.api<any>('getMe');
    this.botId = me.id;
    this.botLabel = me.username ? `@${me.username}` : String(me.id);
    return { id: me.id, username: me.username || '' };
  }

  async start(onMessage: (msg: ChannelInbound) => Promise<string>): Promise<void> {
    if (this.running) return;
    if (!this.token()) return;
    this.onMessage = onMessage;
    this.running = true;
    const gen = ++this.gen;
    try {
      const st = JSON.parse(await fsp.readFile(this.stateFile(), 'utf8'));
      this.offset = Number(st?.offset) || 0;
    } catch { /* 首次运行 */ }
    void this.pollLoop(gen);
  }

  stop(): void {
    this.running = false;
    this.gen += 1; // 在飞的 getUpdates 返回后循环条件失配即退出
  }

  status(): Array<{ accountId: string; running: boolean; label?: string }> {
    if (!this.token()) return [];
    return [{ accountId: this.accountId(), running: this.running, label: this.botLabel || undefined }];
  }

  private async persistOffset(): Promise<void> {
    const file = this.stateFile();
    await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await fsp.writeFile(file, JSON.stringify({ offset: this.offset }), 'utf8').catch(() => {});
  }

  private async pollLoop(gen: number): Promise<void> {
    let failures = 0;
    if (!this.botId) await this.verify().catch((e) => console.warn('[telegram-channel] getMe failed:', e?.message || e));
    console.log(`[telegram-channel] poll loop started (${this.botLabel || 'bot'})`);
    while (this.running && gen === this.gen) {
      try {
        const updates = await this.api<any[]>('getUpdates', {
          offset: this.offset || undefined,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message'],
        }, (POLL_TIMEOUT_S + 15) * 1000);
        if (!this.running || gen !== this.gen) break;
        failures = 0;
        for (const u of updates || []) {
          // 先处理再推进/持久化 offset:处理中途崩溃 → 重启后该条重投一次。
          // handler 错误已捕获(不会重投),不存在毒消息死循环。
          if (u.message) {
            await this.handleMessage(u.message).catch((e: any) => console.warn('[telegram-channel] handle message failed:', e?.message || e));
          }
          if (u.update_id >= this.offset) {
            this.offset = u.update_id + 1;
            await this.persistOffset();
          }
        }
      } catch (e: any) {
        if (!this.running || gen !== this.gen) break;
        failures += 1;
        console.warn(`[telegram-channel] poll error (${failures}):`, e?.message || e);
        const ra = Number(e?.retryAfter);
        await sleep(ra > 0 ? (ra + 1) * 1000 : failures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (failures >= 3) failures = 0;
      }
    }
    console.log('[telegram-channel] poll loop stopped');
  }

  private async download(fileId: string): Promise<{ buffer: Buffer; filePath: string } | null> {
    const f = await this.api<any>('getFile', { file_id: fileId });
    if (!f?.file_path) return null;
    if (typeof f.file_size === 'number' && f.file_size > MAX_FILE_BYTES) return null;
    const res = await fetch(`${TG_API}/file/bot${this.token()}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), filePath: String(f.file_path) };
  }

  private async handleMessage(msg: any): Promise<void> {
    const chatId = msg?.chat?.id;
    const from = msg?.from;
    if (chatId === undefined || chatId === null || from?.is_bot) return;
    const peerId = String(chatId);
    let text = String(msg.text ?? msg.caption ?? '').trim();
    const attachments: InboundImage[] = [];
    const files: InboundFile[] = [];
    // 图片:取最大尺寸那档(photo[] 按尺寸升序)。
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const best = msg.photo[msg.photo.length - 1];
      const dl = await this.download(best.file_id).catch(() => null);
      if (dl) attachments.push({ name: 'photo.jpg', mimeType: 'image/jpeg', data: dl.buffer.toString('base64') });
      else text = [text, '(用户发来图片,但下载失败,请告知用户)'].filter(Boolean).join('\n');
    }
    if (msg.document?.file_id) {
      const dl = await this.download(msg.document.file_id).catch(() => null);
      if (dl) files.push({ name: String(msg.document.file_name || path.basename(dl.filePath)), mimeType: String(msg.document.mime_type || 'application/octet-stream'), buffer: dl.buffer });
      else text = [text, `(用户发来文件 ${msg.document.file_name || ''},但下载失败——可能超过 20MB,请告知用户)`].filter(Boolean).join('\n');
    }
    if (msg.voice?.file_id) {
      const dl = await this.download(msg.voice.file_id).catch(() => null);
      if (dl) files.push({ name: 'voice-message.oga', mimeType: 'audio/ogg', buffer: dl.buffer });
      else text = [text, '(用户发来语音,但下载失败,请告知用户)'].filter(Boolean).join('\n');
    }
    if (!text && !attachments.length && !files.length) return;
    const reply = await this.onMessage?.({ accountId: this.accountId(), peerId, text, messageId: String(msg.message_id ?? ''), attachments: attachments.length ? attachments : undefined, files: files.length ? files : undefined });
    if (reply) await this.send(this.accountId(), peerId, reply);
  }

  /** 同 chat 串行 + 最小间隔;429 按 retry_after 退避一次。 */
  private paced<T>(peerId: string, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const gap = MIN_SEND_INTERVAL_MS - (Date.now() - (this.lastSentAt.get(peerId) ?? 0));
      if (gap > 0) await sleep(gap);
      try {
        return await fn();
      } finally {
        this.lastSentAt.set(peerId, Date.now());
      }
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.then(() => {}, () => {});
    return p;
  }

  async send(_accountId: string, peerId: string, text: string): Promise<SendResult> {
    if (!this.token()) return { ok: false, error: 'telegram not configured' };
    const chunks: string[] = [];
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + MAX_TEXT_LEN, text.length);
      // 别把代理对劈两半(边界落在高位代理上 → 退一位,否则该 emoji 损坏、Telegram 可能整条拒收)。
      if (end < text.length) {
        const c = text.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      }
      chunks.push(text.slice(i, end));
      i = end;
    }
    try {
      for (const chunk of chunks.length ? chunks : ['']) {
        if (!chunk) continue;
        await this.paced(peerId, async () => {
          try {
            await this.api('sendMessage', { chat_id: peerId, text: chunk });
          } catch (e: any) {
            if (e?.retryAfter) {
              await sleep((Number(e.retryAfter) + 1) * 1000);
              await this.api('sendMessage', { chat_id: peerId, text: chunk });
            } else throw e;
          }
        });
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async sendMedia(_accountId: string, peerId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult> {
    if (!this.token()) return { ok: false, error: 'telegram not configured' };
    const method = opts.kind === 'image' ? 'sendPhoto' : 'sendDocument';
    const field = opts.kind === 'image' ? 'photo' : 'document';
    return this.paced(peerId, async () => {
      try {
        const post = async (): Promise<any> => {
          const form = new FormData();
          form.set('chat_id', peerId);
          form.set(field, new Blob([new Uint8Array(buffer)]), opts.fileName || (opts.kind === 'image' ? 'image.png' : 'file.bin'));
          const res = await fetch(`${TG_API}/bot${this.token()}/${method}`, { method: 'POST', body: form, signal: signal ?? AbortSignal.timeout(120_000) });
          return { status: res.status, data: await res.json().catch(() => ({})) };
        };
        let r = await post();
        // 429:按 retry_after 退避重试一次(与文本发送同纪律)。
        const ra = Number(r.data?.parameters?.retry_after);
        if (!r.data.ok && ra > 0) {
          await sleep((ra + 1) * 1000);
          r = await post();
        }
        if (!r.data.ok) return { ok: false, error: `telegram ${method} failed: ${r.data.description || r.status}` };
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
  }

  async setTyping(_accountId: string, peerId: string, on: boolean): Promise<void> {
    if (!on || !this.token()) return; // Telegram 的 typing 动作 ~5s 自动消退,无需显式关闭
    await this.api('sendChatAction', { chat_id: peerId, action: 'typing' }).catch(() => {});
  }
}
