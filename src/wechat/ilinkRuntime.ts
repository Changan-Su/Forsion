/**
 * 多账号 iLink 长轮询运行时。账号 token 只保存在 ~/.tangu/wechat，不进入数据库。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  IlinkClient,
  ILINK_BASE_URL,
  LONG_POLL_TIMEOUT_MS,
  extractText,
  extractImageMedias,
  extractFileMedias,
  describeMediaItems,
  isRateLimited,
  isSessionExpired,
  type IlinkInboundMessage,
  type IlinkMediaKind,
} from './ilinkClient.js';

/** 入站图片附件（下载解密后，喂给 run 的形态，与 Tangu 桌面端一致：{name,mimeType,data(base64)}）。 */
export interface InboundImage { name: string; mimeType: string; data: string }
/** 入站文件（下载解密后交上层落盘;mimeType 可能是嗅探出的图片类型——jpg 当文件发也认得出）。 */
export interface InboundFile { name: string; mimeType: string; buffer: Buffer }

export interface AccountCredentials {
  accountId: string;
  token: string;
  baseUrl?: string;
}

interface AccountState extends AccountCredentials {
  baseUrl: string;
  syncBuf: string;
  contextTokens: Record<string, string>;
}

export interface IlinkRuntimeOptions {
  stateDir: string;
  onMessage: (msg: { accountId: string; openid: string; text: string; messageId?: string; attachments?: InboundImage[]; files?: InboundFile[] }) => Promise<string>;
  onSessionExpired?: (accountId: string) => void;
  logger?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_PAUSE_MS = 600_000;
const DEDUP_TTL_MS = 300_000;
const DEDUP_MAX = 2_000;
// 出站限速:iLink 对连发有限流(ret:-2),超了会**静默丢**后续消息(微信只显示第一条)。
// 同账号所有出站串行 + 最小间隔,命中限流退避重试,别丢消息。
const MIN_SEND_INTERVAL_MS = 1_200;
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 4_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class IlinkRuntime {
  private readonly accounts = new Map<string, AccountState>();
  private readonly clients = new Map<string, IlinkClient>();
  private readonly running = new Set<string>();
  private readonly dedup = new Map<string, Map<string, number>>();
  // typing ticket 缓存:key=`${accountId}:${openid}` → {ticket, expiresAt}(iLink ticket ~600s TTL)。
  private readonly typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  // 出站限速:按账号串行(promise 链尾)+ 最后发送时刻,保证相邻发送不小于 MIN_SEND_INTERVAL_MS。
  private readonly sendChains = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();
  private shuttingDown = false;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;

  constructor(private readonly opts: IlinkRuntimeOptions) {
    this.log = opts.logger ?? ((level, msg) => {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[tangu-wechat] ${msg}`);
      // 同步落盘 stateDir/runtime.log(尽力而为):桌面内置后端 stdout 只进内存 ring buffer,
      // 微信链路排障必须有可 tail 的文件。ponytail: 只追加不轮转,流量极小。
      void fs.appendFile(path.join(this.opts.stateDir, 'runtime.log'), `${new Date().toISOString()} ${level} ${msg}\n`).catch(() => {});
    });
  }

  private accountsFile(): string {
    return path.join(this.opts.stateDir, 'accounts.json');
  }

  private stateFile(accountId: string): string {
    return path.join(this.opts.stateDir, `${encodeURIComponent(accountId)}.state.json`);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
    catch { return fallback; }
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  async loadAccounts(): Promise<void> {
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    const creds = await this.readJson<AccountCredentials[]>(this.accountsFile(), []);
    for (const c of creds) await this.hydrate(c);
    this.log('info', `loaded ${this.accounts.size} account(s)`);
  }

  private async hydrate(c: AccountCredentials): Promise<AccountState> {
    const persisted = await this.readJson<{ syncBuf?: string; contextTokens?: Record<string, string> }>(this.stateFile(c.accountId), {});
    const state: AccountState = {
      accountId: c.accountId,
      token: c.token,
      baseUrl: c.baseUrl || ILINK_BASE_URL,
      syncBuf: persisted.syncBuf ?? '',
      contextTokens: persisted.contextTokens ?? {},
    };
    this.accounts.set(c.accountId, state);
    this.clients.set(c.accountId, new IlinkClient(state.baseUrl, state.token));
    return state;
  }

  private async persistAccountList(): Promise<void> {
    const list: AccountCredentials[] = Array.from(this.accounts.values()).map((a) => ({
      accountId: a.accountId,
      token: a.token,
      baseUrl: a.baseUrl,
    }));
    await this.writeJson(this.accountsFile(), list);
  }

  private persistState(a: AccountState): Promise<void> {
    return this.writeJson(this.stateFile(a.accountId), { syncBuf: a.syncBuf, contextTokens: a.contextTokens });
  }

  async addAccount(c: AccountCredentials): Promise<void> {
    const state = await this.hydrate(c);
    await this.persistAccountList();
    await this.persistState(state);
    if (!this.shuttingDown) this.start(c.accountId);
  }

  async removeAccount(accountId: string): Promise<void> {
    this.stop(accountId);
    this.accounts.delete(accountId);
    this.clients.delete(accountId);
    await this.persistAccountList();
  }

  startAll(): void {
    this.shuttingDown = false;
    for (const id of this.accounts.keys()) this.start(id);
  }

  start(accountId: string): void {
    if (this.running.has(accountId) || !this.accounts.has(accountId)) return;
    this.running.add(accountId);
    void this.pollLoop(accountId);
  }

  stop(accountId: string): void {
    this.running.delete(accountId);
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.running.clear();
  }

  status(): Array<{ accountId: string; running: boolean; peers: number }> {
    return Array.from(this.accounts.values()).map((a) => ({
      accountId: a.accountId,
      running: this.running.has(a.accountId),
      peers: Object.keys(a.contextTokens).length,
    }));
  }

  /**
   * 同账号串行 + 最小间隔执行一次发送(所有出站文本/媒体都经此)。
   * 防止一次回复的「分段文字 + 语音文件」亚秒级连发触发 iLink 限流 → 后续被静默丢。
   */
  private async paced<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sendChains.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.sendChains.set(accountId, prev.then(() => mine));
    await prev.catch(() => {});
    try {
      const gap = MIN_SEND_INTERVAL_MS - (Date.now() - (this.lastSentAt.get(accountId) ?? 0));
      if (gap > 0) await sleep(gap);
      return await fn();
    } finally {
      this.lastSentAt.set(accountId, Date.now());
      release();
    }
  }

  async send(accountId: string, openid: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const account = this.accounts.get(accountId);
    const client = this.clients.get(accountId);
    if (!account || !client) return { ok: false, error: `unknown account ${accountId}` };
    try {
      await this.sendWithContext(account, client, openid, text);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * 发送图片 / 文件给某用户(走 context_token,会话过期则清缓存)。
   * 与文本不同:媒体上游业务错误会被显式上报(ok:false),让工具/用户知道是否送达。
   */
  async sendMedia(
    accountId: string,
    openid: string,
    buffer: Buffer,
    opts: { kind: IlinkMediaKind; fileName: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const account = this.accounts.get(accountId);
    const client = this.clients.get(accountId);
    if (!account || !client) return { ok: false, error: `unknown account ${accountId}` };
    return this.paced(accountId, async () => {
      try {
        let res = await client.sendMedia(openid, buffer, opts, account.contextTokens[openid], signal);
        if (isSessionExpired(res)) {
          delete account.contextTokens[openid];
          await this.persistState(account);
          return { ok: false, error: '微信会话已过期,请让对方重新发一条消息或在 Desktop 重新扫码。' };
        }
        for (let i = 0; i < RATE_LIMIT_RETRIES && isRateLimited(res); i++) {
          this.log('warn', `[${accountId}] media rate-limited, retry ${i + 1}/${RATE_LIMIT_RETRIES}`);
          await sleep(RATE_LIMIT_BACKOFF_MS);
          res = await client.sendMedia(openid, buffer, opts, account.contextTokens[openid], signal);
        }
        if ((res.ret ?? 0) !== 0 || (res.errcode ?? 0) !== 0) {
          return { ok: false, error: `iLink 发送失败(ret=${res.ret ?? ''} errcode=${res.errcode ?? ''} ${res.errmsg ?? ''})`.trim() };
        }
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
  }

  /**
   * 给某用户发送「正在输入」状态(best-effort,失败静默)。
   * iLink 需先 getconfig 拿 typing_ticket(按 peer 缓存,~600s TTL)再 sendtyping。
   */
  async setTyping(accountId: string, openid: string, on: boolean): Promise<void> {
    const account = this.accounts.get(accountId);
    const client = this.clients.get(accountId);
    if (!account || !client) return;
    const key = `${accountId}:${openid}`;
    try {
      let entry = this.typingTickets.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        const ticket = await client.getTypingTicket(openid, account.contextTokens[openid]);
        if (!ticket) return;
        entry = { ticket, expiresAt: Date.now() + 580_000 };
        this.typingTickets.set(key, entry);
      }
      await client.sendTyping(openid, entry.ticket, on);
    } catch (e: any) {
      this.log('warn', `[${accountId}] setTyping failed: ${e?.message || e}`);
    }
  }

  private async pollLoop(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId)!;
    const client = this.clients.get(accountId)!;
    let timeoutMs = LONG_POLL_TIMEOUT_MS;
    let failures = 0;
    this.log('info', `poll loop started: ${accountId}`);
    while (this.running.has(accountId) && !this.shuttingDown) {
      try {
        const resp = await client.getUpdates(account.syncBuf, timeoutMs);
        if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
        const ret = resp.ret ?? 0;
        const errcode = resp.errcode ?? 0;
        if (ret !== 0 || errcode !== 0) {
          if (isSessionExpired(resp)) {
            this.opts.onSessionExpired?.(accountId);
            this.log('error', `[${accountId}] session expired; paused until re-login`);
            await sleep(SESSION_EXPIRED_PAUSE_MS);
            continue;
          }
          failures += 1;
          this.log('warn', `[${accountId}] getUpdates ret=${ret} err=${errcode} (${failures})`);
          await sleep(failures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
          if (failures >= 3) failures = 0;
          continue;
        }
        failures = 0;
        const nextBuf = String(resp.get_updates_buf ?? '');
        if (nextBuf && nextBuf !== account.syncBuf) {
          account.syncBuf = nextBuf;
          await this.persistState(account);
        }
        for (const msg of resp.msgs ?? []) {
          await this.handleMessage(account, client, msg).catch((e: any) =>
            this.log('error', `[${accountId}] handle message failed: ${e?.message || e}`),
          );
        }
      } catch (e: any) {
        failures += 1;
        this.log('error', `[${accountId}] poll error: ${e?.message || e}`);
        await sleep(failures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (failures >= 3) failures = 0;
      }
    }
    this.running.delete(accountId);
    this.log('info', `poll loop stopped: ${accountId}`);
  }

  private isDuplicate(accountId: string, messageId: string): boolean {
    if (!messageId) return false;
    let m = this.dedup.get(accountId);
    if (!m) {
      m = new Map();
      this.dedup.set(accountId, m);
    }
    const now = Date.now();
    if (m.has(messageId) && (m.get(messageId) ?? 0) > now) return true;
    m.set(messageId, now + DEDUP_TTL_MS);
    if (m.size > DEDUP_MAX) {
      for (const [k, exp] of m) if (exp <= now) m.delete(k);
    }
    return false;
  }

  private async handleMessage(account: AccountState, client: IlinkClient, msg: IlinkInboundMessage): Promise<void> {
    const openid = String(msg.from_user_id ?? '').trim();
    // 每条入站消息先记录 item 形状(只字段名不含值):微信媒体格式无文档,静默丢消息时唯一线索就是这行。
    this.log('info', `[${account.accountId}] inbound from=${openid.slice(0, 10)}… items: ${describeMediaItems(msg.item_list) || '(no item_list)'}`);
    if (!openid || openid === account.accountId) return;
    const messageId = String(msg.message_id ?? '');
    if (this.isDuplicate(account.accountId, messageId)) return;
    const contextToken = String(msg.context_token ?? '').trim();
    if (contextToken && account.contextTokens[openid] !== contextToken) {
      account.contextTokens[openid] = contextToken;
      await this.persistState(account);
    }
    const text = extractText(msg.item_list).trim();
    const imageMedias = extractImageMedias(msg.item_list);
    const fileMedias = extractFileMedias(msg.item_list);
    // 消息里图片/文件项的总数(含 media 描述解析不出的),用来发现「有媒体但一件都没解析出」的结构不符。
    const mediaItemCount = (msg.item_list ?? []).filter((it) => it?.type === 2 || it?.type === 4).length;
    if (mediaItemCount > imageMedias.length + fileMedias.length) {
      this.log('warn', `[${account.accountId}] 入站媒体项结构不符（缺 media/encrypt_query_param）：${describeMediaItems(msg.item_list)}`);
    }
    if (!text && !imageMedias.length && !fileMedias.length && !mediaItemCount) return; // 语音已转文字;视频等类型暂不支持
    // 下载解密（尽力而为：单件失败不阻塞其它，也不让整条消息静默丢——最后统计缺口补文字提示）。
    const attachments: InboundImage[] = [];
    for (const m of imageMedias) {
      try {
        const img = await client.downloadMedia(m);
        attachments.push({ name: `wechat-image.${img.mimeType.split('/')[1] || 'jpg'}`, mimeType: img.mimeType, data: img.buffer.toString('base64') });
      } catch (e: any) {
        this.log('warn', `[${account.accountId}] 入站图片处理失败：${e?.message || e} items=${describeMediaItems(msg.item_list)}`);
      }
    }
    const files: InboundFile[] = [];
    for (const f of fileMedias) {
      try {
        const m = await client.downloadMedia(f.media, { expectedSize: f.size });
        files.push({ name: f.fileName, mimeType: m.mimeType, buffer: m.buffer });
      } catch (e: any) {
        this.log('warn', `[${account.accountId}] 入站文件处理失败（${f.fileName}）：${e?.message || e} items=${describeMediaItems(msg.item_list)}`);
      }
    }
    // 有媒体但没全解出来 → 给 agent 一句可见的提示(它可以告知用户重发),不静默。
    const lost = mediaItemCount - attachments.length - files.length;
    const textOut = [text, lost > 0 ? `（用户随消息发来 ${lost} 个图片/文件，但读取失败，请告知用户）` : '']
      .filter(Boolean)
      .join('\n');
    if (!textOut && !attachments.length && !files.length) return;
    const reply = await this.opts.onMessage({
      accountId: account.accountId,
      openid,
      text: textOut,
      messageId,
      attachments: attachments.length ? attachments : undefined,
      files: files.length ? files : undefined,
    });
    if (reply) await this.sendWithContext(account, client, openid, reply);
  }

  private async sendWithContext(account: AccountState, client: IlinkClient, openid: string, text: string): Promise<void> {
    await this.paced(account.accountId, async () => {
      const ctx = account.contextTokens[openid];
      let res = await client.sendText(openid, text, ctx);
      if (isSessionExpired(res) && ctx) {
        delete account.contextTokens[openid];
        await this.persistState(account);
        res = await client.sendText(openid, text);
      }
      // 命中限流(ret:-2)→ 退避重试,别静默丢(否则微信只显示第一条)。
      for (let i = 0; i < RATE_LIMIT_RETRIES && isRateLimited(res); i++) {
        this.log('warn', `[${account.accountId}] send rate-limited, retry ${i + 1}/${RATE_LIMIT_RETRIES} in ${RATE_LIMIT_BACKOFF_MS}ms`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
        res = await client.sendText(openid, text, account.contextTokens[openid]);
      }
      if (isRateLimited(res)) this.log('error', `[${account.accountId}] send 重试后仍被限流,已丢弃 for ${openid}`);
    });
  }
}
