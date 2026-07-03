/**
 * 微信 iLink Bot API 精简客户端。基于 Echo 的已验证实现泛化到 Tangu：
 * QR 登录、长轮询取消息、文本回复。v1 只处理文本与语音转写文本。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
// 微信 c2c 媒体 CDN(发送图片/文件:先把密文 POST 到此处,拿 x-encrypted-param 再 sendmessage 引用)。
const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.2.0';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';
const EP_SEND_TYPING = 'ilink/bot/sendtyping';
const EP_GET_CONFIG = 'ilink/bot/getconfig';
const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl';

export const SESSION_EXPIRED_ERRCODE = -14;
export const RATE_LIMIT_ERRCODE = -2;
export const LONG_POLL_TIMEOUT_MS = 35_000;

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;
const TYPING_START = 1;
const TYPING_STOP = 2;
// getuploadurl 的 media_type(与 item type 不同表):图片=1、视频=2、文件=3。
const MEDIA_IMAGE = 1;
const MEDIA_FILE = 3;
const MEDIA_UPLOAD_TIMEOUT_MS = 120_000;
// 入站媒体下载上限(解密前密文大小)。微信文件可到 100MB+,但 worker 内存有限。
// ponytail: 超限直接拒收并提示,分块/流式解密等真有需求再做。
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export type IlinkMediaKind = 'image' | 'file';

// ── 媒体 AES-128-ECB(PKCS7)──。发送：用 16 字节随机 key 加密原文,密文 POST 到 CDN;
//    sendmessage 里携带的 aes_key = base64(该 key 的 32 字符 hex 串)——必须是 hex 串再 base64,
//    直接 base64(原始 16 字节)会导致对端解不出(图片显示灰块)。
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 图片魔数 → mime（解密后嗅探；下载的密文无 Content-Type 可信）。 */
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/** aes_key 字段的候选 16 字节 key：出站规范是 base64(32 字符 hex 串)，入站真机格式未定 → 三种解法都试。 */
function candidateKeys(aesKeyField: string): Buffer[] {
  const keys: Buffer[] = [];
  const push = (b: Buffer): void => { if (b.length === 16 && !keys.some((k) => k.equals(b))) keys.push(b); };
  const dec = Buffer.from(aesKeyField, 'base64');
  const ascii = dec.toString('ascii');
  if (/^[0-9a-fA-F]{32}$/.test(ascii)) push(Buffer.from(ascii, 'hex')); // base64(hex 串) —— 出站同款
  push(dec); // base64(原始 16 字节)
  if (/^[0-9a-fA-F]{32}$/.test(aesKeyField)) push(Buffer.from(aesKeyField, 'hex')); // 裸 hex 串
  return keys;
}

/**
 * 解码一条入站媒体密文：密钥格式 × 算法(ECB / CBC-零IV) × 明文直通 全组合尝试，
 * 用内容验真挑出正确解 —— 图片看魔数，文件看解出长度 === expectedSize（PKCS7 撞对 key 的概率可忽略）。
 * 入站加密由微信客户端产生、无文档，穷举 + 验真比信 encrypt_type 字段可靠。
 */
export function decodeMediaBuffer(
  cipherBuf: Buffer,
  aesKeyField: string,
  expectedSize?: number,
): { buffer: Buffer; mimeType: string } | null {
  const candidates: Buffer[] = [cipherBuf]; // 直通:encrypt_type=0/未加密的情况
  for (const algo of ['aes-128-ecb', 'aes-128-cbc'] as const) {
    for (const key of candidateKeys(aesKeyField)) {
      try {
        const d = createDecipheriv(algo, key, algo === 'aes-128-cbc' ? Buffer.alloc(16) : null);
        candidates.push(Buffer.concat([d.update(cipherBuf), d.final()]));
      } catch { /* 坏 padding → 非此解 */ }
    }
  }
  for (const c of candidates) {
    const mimeType = sniffImageMime(c);
    if (mimeType) return { buffer: c, mimeType };
  }
  if (expectedSize) {
    for (const c of candidates) if (c.length === expectedSize) return { buffer: c, mimeType: 'application/octet-stream' };
  }
  return null;
}

export interface IlinkInboundMessage {
  from_user_id?: string;
  message_id?: string;
  context_token?: string;
  item_list?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface IlinkUpdate {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface IlinkSendResult {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  [k: string]: unknown;
}

export interface QrStart {
  qrcode: string;
  qrcodeImg: string;
}

export interface QrStatus {
  status: string;
  redirectHost?: string;
  accountId?: string;
  token?: string;
  baseUrl?: string;
  userId?: string;
}

function randomWechatUin(): string {
  return String(randomBytes(4).readUInt32BE(0));
}

function postHeaders(token: string | undefined, body: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const getHeaders: Record<string, string> = {
  'iLink-App-Id': ILINK_APP_ID,
  'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
};

async function fetchJson(
  url: string,
  init: { method: string; body?: string; headers: Record<string, string> },
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`iLink HTTP ${resp.status}: ${raw.slice(0, 200)}`);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } finally {
    clearTimeout(timer);
  }
}

export function extractText(itemList: Array<Record<string, unknown>> | undefined): string {
  for (const item of itemList ?? []) {
    if (item?.type === ITEM_TEXT) return String((item.text_item as any)?.text ?? '');
  }
  for (const item of itemList ?? []) {
    if (item?.type === ITEM_VOICE) {
      const t = String((item.voice_item as any)?.text ?? '');
      if (t) return t;
    }
  }
  return '';
}

export interface IlinkImageMedia { encrypt_query_param: string; aes_key: string; encrypt_type: number; download_url?: string }
export interface IlinkFileMedia { media: IlinkImageMedia; fileName: string; size: number }

function toMedia(media: any): IlinkImageMedia | null {
  if (!media?.encrypt_query_param) return null;
  return {
    encrypt_query_param: String(media.encrypt_query_param),
    aes_key: String(media.aes_key ?? ''),
    encrypt_type: Number(media.encrypt_type ?? 0),
    // 有些实现直接给完整下载 URL(真机实测字段叫 full_url);有就优先用,没有再按 /c2c/download 对称拼。
    download_url: String(media.full_url ?? media.download_full_url ?? media.download_url ?? media.url ?? '') || undefined,
  };
}

/** 抽出所有入站图片项的 media 描述（供 downloadMedia 下载解密）。结构与 sendMedia 出站对称。 */
export function extractImageMedias(itemList: Array<Record<string, unknown>> | undefined): IlinkImageMedia[] {
  const out: IlinkImageMedia[] = [];
  for (const item of itemList ?? []) {
    if (item?.type !== ITEM_IMAGE) continue;
    const m = toMedia((item.image_item as any)?.media);
    if (m) out.push(m);
  }
  return out;
}

/** 抽出所有入站文件项（file_item.media + 文件名/原始大小，与出站 sendMedia 的 file_item 对称）。 */
export function extractFileMedias(itemList: Array<Record<string, unknown>> | undefined): IlinkFileMedia[] {
  const out: IlinkFileMedia[] = [];
  for (const item of itemList ?? []) {
    if (item?.type !== ITEM_FILE) continue;
    const fi = item.file_item as any;
    const m = toMedia(fi?.media);
    if (m) out.push({ media: m, fileName: String(fi?.file_name ?? '') || 'wechat-file', size: Number(fi?.len ?? 0) || 0 });
  }
  return out;
}

/**
 * 诊断用:把 item_list 压成「type=2[media,mid_size]{media:encrypt_query_param,aes_key,…}」形状串。
 * 只输出字段名不输出值(密钥/密文参数不落日志),供解析失败时看清真实入站结构。
 */
export function describeMediaItems(itemList: Array<Record<string, unknown>> | undefined): string {
  return (itemList ?? [])
    .map((it) => {
      const t = Number(it?.type ?? -1);
      const body = Object.entries(it ?? {}).find(([k]) => k.endsWith('_item'))?.[1] as Record<string, unknown> | undefined;
      const keys = body ? Object.keys(body).join(',') : '';
      const media = body?.media as Record<string, unknown> | undefined;
      return `type=${t}[${keys}]${media ? `{media:${Object.keys(media).join(',')}}` : ''}`;
    })
    .join(' ');
}

export function isSessionExpired(u: { ret?: number; errcode?: number; errmsg?: string }): boolean {
  if (u.ret === SESSION_EXPIRED_ERRCODE || u.errcode === SESSION_EXPIRED_ERRCODE) return true;
  return (
    (u.ret === RATE_LIMIT_ERRCODE || u.errcode === RATE_LIMIT_ERRCODE) &&
    (u.errmsg || '').toLowerCase() === 'unknown error'
  );
}

export function isRateLimited(u: { ret?: number; errcode?: number; errmsg?: string }): boolean {
  if (isSessionExpired(u)) return false;
  return u.ret === RATE_LIMIT_ERRCODE || u.errcode === RATE_LIMIT_ERRCODE;
}

export class IlinkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async post(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
    const url = `${this.baseUrl.replace(/\/+$/, '')}/${endpoint}`;
    return fetchJson(url, { method: 'POST', body, headers: postHeaders(this.token, body) }, timeoutMs);
  }

  async getUpdates(syncBuf: string, timeoutMs = LONG_POLL_TIMEOUT_MS): Promise<IlinkUpdate> {
    try {
      return (await this.post(EP_GET_UPDATES, { get_updates_buf: syncBuf }, timeoutMs)) as IlinkUpdate;
    } catch (e: any) {
      if (e?.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: syncBuf };
      throw e;
    }
  }

  async sendText(to: string, text: string, contextToken?: string, clientId?: string): Promise<IlinkSendResult> {
    const msg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId || randomUUID(),
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    };
    if (contextToken) msg.context_token = contextToken;
    return (await this.post(EP_SEND_MESSAGE, { msg }, API_TIMEOUT_MS)) as IlinkSendResult;
  }

  /** 取 typing ticket(iLink「正在输入」凭据,约 600s TTL;getconfig 端点)。 */
  async getTypingTicket(ilinkUserId: string, contextToken?: string): Promise<string> {
    const payload: Record<string, unknown> = { ilink_user_id: ilinkUserId };
    if (contextToken) payload.context_token = contextToken;
    const r = await this.post(EP_GET_CONFIG, payload, API_TIMEOUT_MS);
    return String(r.typing_ticket ?? '');
  }

  /** 向某用户发送「正在输入」状态(on=true 开始 / false 停止;sendtyping 端点)。 */
  async sendTyping(toUserId: string, typingTicket: string, on: boolean): Promise<void> {
    await this.post(
      EP_SEND_TYPING,
      { ilink_user_id: toUserId, typing_ticket: typingTicket, status: on ? TYPING_START : TYPING_STOP },
      API_TIMEOUT_MS,
    );
  }

  /** POST 密文到 CDN(完整 URL 由调用方按 upload_full_url / upload_param 决定),取回 x-encrypted-param。parentSignal:run 中止时联动取消(最长 120s 的步骤)。 */
  private async uploadCdn(uploadUrl: string, ciphertext: Buffer, parentSignal?: AbortSignal): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEDIA_UPLOAD_TIMEOUT_MS);
    const onParentAbort = (): void => ctrl.abort();
    if (parentSignal) {
      if (parentSignal.aborted) ctrl.abort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    try {
      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`iLink CDN upload HTTP ${resp.status}`);
      const param = resp.headers.get('x-encrypted-param');
      if (!param) throw new Error('iLink CDN upload: missing x-encrypted-param');
      return param;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * 上传一段媒体到 CDN,返回 sendmessage 里 item.media 引用的密文描述。
   * 三步:getuploadurl → AES-128-ECB 加密 → POST CDN 取 x-encrypted-param。
   * 会话过期时返回 { expired } 让调用方按会话过期处理(清 context / 提示重连)。
   * aes_key 必须是 base64(32 字符 hex 串)、encrypt_type 必须是 1(图片/文件/语音统一,少一个都收不到)。
   */
  private async uploadEncryptedMedia(
    to: string,
    buffer: Buffer,
    mediaType: number,
    signal?: AbortSignal,
  ): Promise<{ media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }; filesize: number } | { expired: IlinkSendResult }> {
    const rawsize = buffer.length;
    const rawfilemd5 = createHash('md5').update(buffer).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aesKey = randomBytes(16);
    const aesKeyHex = aesKey.toString('hex');

    const up = await this.post(
      EP_GET_UPLOAD_URL,
      { filekey, media_type: mediaType, to_user_id: to, rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aesKeyHex },
      API_TIMEOUT_MS,
    );
    if (isSessionExpired(up as any)) return { expired: up as IlinkSendResult };
    // iLink 不同账号/版本二选一返回:upload_full_url(直接给完整 CDN URL,优先)或 upload_param(需自拼 CDN URL)。
    const uploadFullUrl = String((up as any).upload_full_url ?? '');
    const uploadParam = String((up as any).upload_param ?? '');
    const uploadUrl = uploadFullUrl
      || (uploadParam ? `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}` : '');
    if (!uploadUrl) throw new Error(`iLink getuploadurl 未返回 upload_full_url/upload_param:${JSON.stringify(up).slice(0, 300)}`);

    const ciphertext = encryptAesEcb(buffer, aesKey);
    const downloadParam = await this.uploadCdn(uploadUrl, ciphertext, signal);
    return { media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(aesKeyHex, 'ascii').toString('base64'), encrypt_type: 1 }, filesize };
  }

  /** 组 bot 消息信封并发出(from_user_id 必须空串,不能传 bot_id)。 */
  private async sendItem(to: string, item: Record<string, unknown>, contextToken?: string): Promise<IlinkSendResult> {
    const msg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: to,
      client_id: randomUUID(),
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [item],
    };
    if (contextToken) msg.context_token = contextToken;
    return (await this.post(EP_SEND_MESSAGE, { msg }, API_TIMEOUT_MS)) as IlinkSendResult;
  }

  /**
   * 发送图片 / 文件给某用户。getuploadurl → 加密上传 CDN → sendmessage 引用密文。
   * 上传步的上游业务错误(ret/errcode)由 getuploadurl/CDN 抛出;最终 sendmessage 结果原样返回(调用方判 ret)。
   */
  async sendMedia(
    to: string,
    buffer: Buffer,
    opts: { kind: IlinkMediaKind; fileName: string },
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<IlinkSendResult> {
    const mediaType = opts.kind === 'image' ? MEDIA_IMAGE : MEDIA_FILE;
    const uploaded = await this.uploadEncryptedMedia(to, buffer, mediaType, signal);
    if ('expired' in uploaded) return uploaded.expired;
    const { media, filesize } = uploaded;
    const item = opts.kind === 'image'
      ? { type: ITEM_IMAGE, image_item: { media, mid_size: filesize } }
      : { type: ITEM_FILE, file_item: { media, file_name: opts.fileName, len: String(buffer.length) } };
    return this.sendItem(to, item, contextToken);
  }

  /**
   * 下载并解码一条入站媒体（图片/文件）。
   *   GET CDN /c2c/download?encrypted_query_param=<param>（或 media 自带完整下载 URL）取密文，
   *   再 decodeMediaBuffer 穷举解码。解不出/缺字段 → 抛带形状诊断的错误（不含密钥本体），
   *   调用方记日志并给 agent 文字兜底，绝不静默丢整条消息。
   */
  async downloadMedia(media: IlinkImageMedia, opts?: { expectedSize?: number }): Promise<{ mimeType: string; buffer: Buffer }> {
    if (!media.encrypt_query_param || !media.aes_key) {
      throw new Error(`入站媒体缺字段(encrypt_type=${media.encrypt_type} has_param=${!!media.encrypt_query_param} has_key=${!!media.aes_key})`);
    }
    const url = media.download_url
      || `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEDIA_UPLOAD_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: 'GET', headers: getHeaders, signal: ctrl.signal });
      if (!resp.ok) throw new Error(`iLink CDN download HTTP ${resp.status}`);
      const cipher = Buffer.from(await resp.arrayBuffer());
      if (cipher.length > MEDIA_MAX_BYTES) throw new Error(`入站媒体过大(${cipher.length}B > ${MEDIA_MAX_BYTES}B)`);
      const decoded = decodeMediaBuffer(cipher, media.aes_key, opts?.expectedSize);
      if (!decoded) {
        const keyDec = Buffer.from(media.aes_key, 'base64');
        throw new Error(
          `入站媒体解码失败(encrypt_type=${media.encrypt_type} key_len=${media.aes_key.length} key_declen=${keyDec.length} `
          + `cipher_len=${cipher.length} expected=${opts?.expectedSize ?? '-'} head=${cipher.subarray(0, 8).toString('hex')})`,
        );
      }
      return decoded;
    } finally {
      clearTimeout(timer);
    }
  }

  static async qrStart(baseUrl = ILINK_BASE_URL, botType = '3'): Promise<QrStart> {
    const url = `${baseUrl.replace(/\/+$/, '')}/${EP_GET_BOT_QR}?bot_type=${botType}`;
    const r = await fetchJson(url, { method: 'GET', headers: getHeaders }, QR_TIMEOUT_MS);
    return { qrcode: String(r.qrcode ?? ''), qrcodeImg: String(r.qrcode_img_content ?? '') };
  }

  static async qrStatus(baseUrl: string, qrcode: string): Promise<QrStatus> {
    const url = `${baseUrl.replace(/\/+$/, '')}/${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`;
    const r = await fetchJson(url, { method: 'GET', headers: getHeaders }, QR_TIMEOUT_MS);
    return {
      status: String(r.status ?? 'wait'),
      redirectHost: r.redirect_host ? String(r.redirect_host) : undefined,
      accountId: r.ilink_bot_id ? String(r.ilink_bot_id) : undefined,
      token: r.bot_token ? String(r.bot_token) : undefined,
      baseUrl: r.baseurl ? String(r.baseurl) : undefined,
      userId: r.ilink_user_id ? String(r.ilink_user_id) : undefined,
    };
  }
}
