/**
 * 发给模型前脱敏(借鉴 yetone/magpie 的 redact,MIT;方案页 docs/ToBeImproved/借鉴magpie方案_2026-10-28/mask.html)。
 *
 * 引擎出站一处:包住 brain.llm.streamProviderCompletion,直连 / 订阅 / Forsion 云端一视同仁。
 *   - 出站:整包(payload 里所有字符串,不按字段名挑)把密钥 / 令牌换成 `{{API_KEY_xxxxxxxx}}`。占位符由本机一把随机密钥
 *     HMAC 派生:同一值永远同一占位符、重启不变 → 提示词缓存不断。这把密钥只在 tanguHome,不随同步走。
 *   - 回程:回复文本、思考文本、工具调用参数里的占位符在交回 agentLoop 之前换回真值(工具执行用的是真值)。流式输出按最长
 *     占位符长度留尾,防止占位符被切成两半。厂商签过名的思考块(outputItems)原样不动 —— 签名盖的是占位符版本。
 *   - 开着却跑不了 → 抛不可重试的 LlmError,这一轮不发,绝不悄悄原样发出。
 *   - 「从不遮住」只存值的 HMAC;记录只留类型 / 长度 / 头 4 字符,7 天,只在本机。
 * 与 core/redact.ts 无关:那个是记忆 / 诊断用的单向 [REDACTED],不可逆。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LlmError, type ToolCall } from '../core/types.js';
import type { LlmBrain, StreamOpts, StreamResult } from '../seams/cloudBrain.js';
import { getRawSection } from '../core/config.js';
import { tanguHome } from '../core/tanguHome.js';

export type MaskAction = 'mask' | 'warn' | 'block';
export interface MaskSettings { secrets: boolean; personal: boolean; action: MaskAction }
/** 一个被找到的值(不含原值):kind 类型、ph 占位符、head 头 4 字符、len 长度。 */
export interface MaskHit { kind: string; ph: string; head: string; len: number }

export const DEFAULT_MASK_SETTINGS: MaskSettings = { secrets: true, personal: false, action: 'mask' };

/** config.json 的 `masking` 段;缺省 = 密钥开、个人信息关、遮住。 */
export function maskSettings(): MaskSettings {
  const raw = getRawSection('masking') || {};
  return {
    secrets: raw.secrets !== false,
    personal: raw.personal === true,
    action: raw.action === 'warn' || raw.action === 'block' ? raw.action : 'mask',
  };
}

// ── 规则(magpie internal/redact/redact.go 里密钥 / 个人信息那两组的子集)──────────────────────────
const TOKEN_CH = 'A-Za-z0-9_-';
const ALNUM = 'A-Za-z0-9';
const SECRET_CH = '[A-Za-z0-9_\\-./+=~!@#%^&*]';
const QUOTE = `(?:\\\\?["'])?`;
const SECRET_NAMES = 'password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential';

const hasLetter = (v: string) => /[A-Za-z]/.test(v);
const hasDigit = (v: string) => /\d/.test(v);
/** `$VAR` / `${…}` / `<your key>` / `****` 之类是占位写法,不是值。 */
const notAVariable = (v: string) => !/^[$%{<[*]/.test(v) && v.replace(/[*xX.]/g, '') !== '';
/** 配置里的密钥值:字母和数字都有;`process.env.X` / `os.getenv` 是代码不是值。 */
const secretValue = (v: string) => notAVariable(v) && !/^(?:process\.env|os\.)/.test(v) && hasLetter(v) && hasDigit(v);
/** `sk-` 开头的 slug(sk-learn-model-v2)不是 key:有大写,或全是 hex,或有一段 ≥16 才算。 */
const notASlug = (v: string) => /[A-Z]/.test(v) || !/[^-_0-9a-f]/.test(v.slice(3)) || v.split(/[-_]/).some((w) => w.length >= 16);
const luhn = (v: string) => {
  const d = v.replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i];
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return d.length >= 13 && sum % 10 === 0;
};
const chineseId = (v: string) => {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = w.reduce((s, x, i) => s + x * +v[i], 0);
  return '10X98765432'[sum % 11] === v[17].toUpperCase();
};
const FILE_EXT = /\.(?:png|jpe?g|gif|svg|webp|ico|json|js|mjs|cjs|ts|tsx|jsx|css|md|txt|lock|ya?ml|toml|html?|py|go|rs)$/i;

interface Rule {
  kind: string;
  re: RegExp;
  /** 两侧不许挨着的字符(长单词里的一截不是 key)。 */
  bound?: string;
  ok?: (v: string, s: string, at: number) => boolean;
  personal?: boolean;
}
const R = (src: string, flags = 'g') => new RegExp(src, flags);
const RULES: Rule[] = [
  { kind: 'PRIVATE_KEY', re: R('-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----') },
  { kind: 'API_KEY', re: R('sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}'), bound: TOKEN_CH, ok: notASlug },
  { kind: 'API_KEY', re: R('[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}'), bound: TOKEN_CH, ok: secretValue },
  { kind: 'API_KEY', re: R('(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})'), bound: TOKEN_CH },
  { kind: 'API_KEY', re: R('AIza[0-9A-Za-z_-]{35}'), bound: TOKEN_CH },
  { kind: 'API_KEY', re: R('xox[abposr]-[0-9A-Za-z-]{10,}'), bound: TOKEN_CH },
  { kind: 'API_KEY', re: R('(?:sk|rk)_live_[0-9A-Za-z]{20,}'), bound: TOKEN_CH },
  { kind: 'API_KEY', re: R('(?:AKIA|ASIA)[0-9A-Z]{16}'), bound: ALNUM },
  { kind: 'API_KEY', re: R('(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43})'), bound: TOKEN_CH },
  { kind: 'TOKEN', re: R('eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'), bound: TOKEN_CH },
  // Authorization: Bearer <token>
  { kind: 'TOKEN', re: R('\\b[Bb]earer[ \\t]+([A-Za-z0-9._~+/-]{16,}=*)'), ok: secretValue },
  // user:password@host 里的 password(Redis 那种 :password@host 也算)
  { kind: 'PASSWORD', re: R(`[A-Za-z][A-Za-z0-9+.-]*://[^\\s:@/?#"'<>]*:([^\\s@/?#"'<>]{3,})@`), ok: notAVariable },
  // .env / 配置里的 DB_PASSWORD=… / "apiKey": "…"
  { kind: 'SECRET', re: R(`[A-Za-z0-9_.-]*(?:${SECRET_NAMES})[A-Za-z0-9_.-]*${QUOTE}[ \\t]*[:=][ \\t]*${QUOTE}(${SECRET_CH}{8,})`, 'gi'), ok: secretValue },
  // 中文里说出来的:密码：786kih / 密钥为 …
  { kind: 'PASSWORD', re: R(`(?:密码|密碼|口令)[ \\t]*(?:[:：=]|[为為是][ \\t]*[:：]?)[ \\t]*["'“「]?(${SECRET_CH}{4,63})`), ok: notAVariable },
  { kind: 'SECRET', re: R(`(?:密钥|密鑰|令牌|金鑰)[ \\t]*(?:[:：=]|[为為是][ \\t]*[:：]?)[ \\t]*["'“「]?(${SECRET_CH}{6,})`), ok: (v) => notAVariable(v) && (hasLetter(v) || v.length >= 6) },

  { kind: 'EMAIL', re: R('[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}'), bound: ALNUM + '_%+-', ok: (v) => !/^git@/i.test(v) && !FILE_EXT.test(v), personal: true },
  { kind: 'ID_CARD', re: R('[1-9]\\d{5}(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]'), bound: ALNUM, ok: chineseId, personal: true },
  // 11 位 1[3-9] 开头既是手机号也是订单号的样子:前面紧挨着 id / 订单号 之类就不算
  { kind: 'PHONE', re: R('(?:\\+?86[- ]?)?1[3-9]\\d{9}'), bound: ALNUM, ok: (_v, s, at) => !/(?:id|order|no\.?|#|号)[\s:：=_-]*$/i.test(s.slice(Math.max(0, at - 12), at)), personal: true },
  { kind: 'BANK_CARD', re: R('[3-6]\\d{3}(?:[ -]?\\d{4}){2,3}(?:[ -]?\\d{1,3})?'), bound: ALNUM, ok: luhn, personal: true },
];

interface Span { start: number; end: number; kind: string; value: string }

/** 在一段文本里找敏感值(按出现顺序,互不重叠)。 */
export function findSensitive(text: string, opts: Pick<MaskSettings, 'secrets' | 'personal'> = DEFAULT_MASK_SETTINGS): Span[] {
  const spans: Span[] = [];
  for (const r of RULES) {
    if (r.personal ? !opts.personal : !opts.secrets) continue;
    r.re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = r.re.exec(text)); ) {
      const value = m[1] ?? m[0];
      const start = m.index + (m[1] != null ? m[0].lastIndexOf(m[1]) : 0);
      const end = start + value.length;
      if (r.bound) {
        const b = new RegExp(`[${r.bound}]`);
        if ((start > 0 && b.test(text[start - 1])) || (end < text.length && b.test(text[end]))) continue;
      }
      if (r.ok && !r.ok(value, text, start)) continue;
      // 规则按优先级排:和前面规则认出的重叠就让(postgres://app:密码@host 里先是密码,不是邮箱)
      if (spans.some((x) => start < x.end && end > x.start)) continue;
      spans.push({ start, end, kind: r.kind, value });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// ── 本机密钥 / 占位符 ──────────────────────────────────────────────────────────────────────────
const maskDir = () => join(tanguHome(), 'masking');
let keyCache: { home: string; key: Buffer } | null = null;
function maskKey(): Buffer {
  const home = tanguHome();
  if (keyCache?.home === home) return keyCache.key;
  const file = join(maskDir(), 'key');
  let key: Buffer;
  if (existsSync(file)) key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  else {
    mkdirSync(maskDir(), { recursive: true });
    key = randomBytes(32);
    writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  }
  if (key.length < 16) throw new Error('masking key is unreadable');
  keyCache = { home, key };
  return key;
}
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function b32(buf: Buffer, n: number): string {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < n) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= n) break;
  }
  return out;
}
export function placeholderFor(kind: string, value: string): string {
  return `{{${kind}_${b32(createHmac('sha256', maskKey()).update(`${kind}\0${value}`).digest(), 8)}}}`;
}
/** 「从不遮住」存的是这个,不存原值。 */
export const allowHash = (value: string) => createHmac('sha256', maskKey()).update(`allow\0${value}`).digest('hex');

// ── 从不遮住 ────────────────────────────────────────────────────────────────────────────────────
export interface AllowEntry { hash: string; kind: string; head: string; len: number; at: number }
const allowFile = () => join(maskDir(), 'allow.json');
export function readAllowList(): AllowEntry[] {
  try { const v = JSON.parse(readFileSync(allowFile(), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeJsonAtomic(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(v), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
/** 加进「从不遮住」:只存 HMAC + 类型 / 头 4 字符 / 长度(给管理列表看)。值由界面从它手里的工具结果里取。 */
export function allowValue(value: string, kind: string): AllowEntry {
  const hash = allowHash(value);
  const entry: AllowEntry = { hash, kind, head: value.slice(0, 4), len: value.length, at: Date.now() };
  writeJsonAtomic(allowFile(), [...readAllowList().filter((e) => e.hash !== hash), entry]);
  return entry;
}
export function removeAllow(hash: string): void {
  writeJsonAtomic(allowFile(), readAllowList().filter((e) => e.hash !== hash));
}

// ── 记录:类型 / 长度 / 头 4 字符,7 天,只在本机 ──────────────────────────────────────────────────
export interface MaskLogLine { t: number; sid: string; action: MaskAction; hits: MaskHit[] }
const logFile = () => join(maskDir(), 'log.jsonl');
const LOG_DAYS = 7;
const logged = new Set<string>(); // 同一会话同一个值只记一次(每轮都会重发历史)
let pruned = false;
function appendLog(sid: string, action: MaskAction, hits: MaskHit[]): void {
  const fresh = hits.filter((h) => !logged.has(`${sid}\0${h.ph}`));
  if (!fresh.length) return;
  fresh.forEach((h) => logged.add(`${sid}\0${h.ph}`));
  mkdirSync(maskDir(), { recursive: true });
  if (!pruned) { pruned = true; readMaskLog(); }
  appendFileSync(logFile(), JSON.stringify({ t: Date.now(), sid, action, hits: fresh } satisfies MaskLogLine) + '\n', { mode: 0o600 });
}
/** 读最近 7 天(顺手把更早的删掉)。 */
export function readMaskLog(): MaskLogLine[] {
  let lines: MaskLogLine[] = [];
  try { lines = readFileSync(logFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  const since = Date.now() - LOG_DAYS * 86400_000;
  const kept = lines.filter((l) => l.t >= since);
  if (kept.length < lines.length) writeFileSync(logFile(), kept.map((l) => JSON.stringify(l) + '\n').join(''), { mode: 0o600 });
  return kept;
}

// ── 出站:整包脱敏 ──────────────────────────────────────────────────────────────────────────────
/** 不碰的字段:工具定义 / 模型名 / 各种 id / 厂商签过名或加密的内容。签名盖的是厂商写的原文,改一个字就 400。 */
const SKIP_KEYS = new Set(['tools', 'tool_choice', 'model', 'modelId', 'response_format', 'encrypted_content', 'signature', 'id', 'call_id', 'tool_call_id', 'tool_use_id', 'prompt_cache_key', 'cacheKey']);
/** 图片的 base64(长、无空白、只有 base64 字符):随机字节里偶尔能凑出 AKIA… 的样子,不扫。 */
const isBlob = (s: string) => s.length > 2000 && !/[^A-Za-z0-9+/=_-]/.test(s.slice(0, 2000));
const SEALED_TYPES = new Set(['thinking', 'redacted_thinking', 'reasoning']);
/** 进程内:占位符 → 原值(换回用),原值 → 占位符(之后哪里再出现这个值都换,哪怕没有上下文能让规则认出它)。只在内存。 */
const phValue = new Map<string, string>();
const known = new Map<string, { kind: string; ph: string }>();
const KNOWN_MAX = 2000;
const KNOWN_MIN_LEN = 8;
function remember(value: string, kind: string, ph: string): void {
  phValue.set(ph, value);
  if (value.length < KNOWN_MIN_LEN) return;
  known.delete(value);
  known.set(value, { kind, ph });
  if (known.size > KNOWN_MAX) known.delete(known.keys().next().value!);
}

export interface MaskResult { payload: any; hits: MaskHit[]; map: Map<string, string> }

/** 把整包里的敏感值换成占位符。warn 档只找不换。不改入参(消息对象可能和 agentLoop 的历史共用引用)。 */
export function maskPayload(payload: any, settings: MaskSettings): MaskResult {
  const allowSet = new Set(readAllowList().map((e) => e.hash));
  const allowedMemo = new Map<string, boolean>();
  const allowed = (v: string): boolean => {
    let r = allowedMemo.get(v);
    if (r === undefined) allowedMemo.set(v, (r = allowSet.has(allowHash(v))));
    return r;
  };
  const hits = new Map<string, MaskHit>();
  const map = new Map<string, string>();
  const replace = settings.action !== 'warn';
  let replaced = 0;
  /** 整包里每个字符串过一遍 fn。JSON 文本(工具参数 / JSON 结果)按叶子过、改了才重新序列化:占位符对应的总是原值,
   *  不是 JSON 转义后的样子,换回时才对得上。跳过的字段与签过名的块只在 payload 本身的结构上认,不在 JSON 文本里认。 */
  const each = (v: any, fn: (s: string) => string, inner = false): any => {
    if (typeof v === 'string') {
      if (v.length < 8 || v.startsWith('data:') || isBlob(v)) return v;
      if (/^\s*[{[]/.test(v)) {
        const parsed = tryJson(v);
        if (parsed && typeof parsed === 'object') {
          const before = replaced;
          const leaves = each(parsed, fn, true);
          return replaced > before ? JSON.stringify(leaves) : v;
        }
      }
      return fn(v);
    }
    if (Array.isArray(v)) return v.map((x) => each(x, fn, inner));
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
    if (!inner && SEALED_TYPES.has(v.type) && (v.signature || v.encrypted_content || v.type === 'redacted_thinking')) return v;
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = !inner && SKIP_KEYS.has(k) ? x : each(x, fn, inner);
    return o;
  };
  // 第一遍:只认,不换 —— 认出的值进 known,第二遍整包里原样出现的地方都换(模型回复里复述的密码没有上下文,规则认不出来)
  each(payload, (s) => {
    for (const sp of findSensitive(s, settings)) if (!allowed(sp.value)) remember(sp.value, sp.kind, placeholderFor(sp.kind, sp.value));
    return s;
  });
  const knownNow = [...known.entries()].filter(([value]) => !allowed(value));
  const byValue = new Map(knownNow);
  const knownRe = knownNow.length ? valuesRe(knownNow.map(([v]) => v)) : null;
  const out = each(payload, (s) => {
    const spans: Array<{ start: number; end: number; kind: string; value: string }> = findSensitive(s, settings).filter((sp) => !allowed(sp.value));
    if (knownRe) for (const m of s.matchAll(knownRe)) {
      const start = m.index!, end = start + m[0].length;
      if (!spans.some((x) => start < x.end && end > x.start)) spans.push({ start, end, kind: byValue.get(m[0])!.kind, value: m[0] });
    }
    if (!spans.length) return s;
    spans.sort((a, b) => a.start - b.start);
    let res = '', last = 0;
    for (const sp of spans) {
      const ph = placeholderFor(sp.kind, sp.value);
      remember(sp.value, sp.kind, ph);
      map.set(ph, sp.value);
      if (!hits.has(ph)) hits.set(ph, { kind: sp.kind, ph, head: sp.value.slice(0, 4), len: sp.value.length });
      res += s.slice(last, sp.start) + (replace ? ph : sp.value);
      last = sp.end;
    }
    if (replace) replaced++;
    return res + s.slice(last);
  });
  // 兜底自检:遮住档下,整包里不许再出现任何一个被遮的原值(≥8 字符;短值可能是普通词)。查到 = 脱敏有漏洞,宁可拦下这一轮
  const long = [...map.values()].filter((v) => v.length >= KNOWN_MIN_LEN);
  if (replace && long.length) {
    const re = valuesRe(long, ''); // 不带 g:test() 不留 lastIndex
    each(out, (s) => { if (re.test(s)) throw new Error('a masked value is still in the request'); return s; });
  }
  return { payload: out, hits: [...hits.values()], map };
}
const valuesRe = (values: string[], flags = 'g') => new RegExp(values.sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), flags);

/** 界面用:一段工具参数 / 结果里,发出时会被遮住的值在哪(不含原值,界面从自己手里的文本按位置取)。规则 + 之前认出过的值。 */
export interface MaskSpan { kind: string; ph: string; s: number; e: number }
export function maskSpans(text: string, settings: MaskSettings = maskSettings()): MaskSpan[] {
  if ((!settings.secrets && !settings.personal) || !text || text.length < 8) return [];
  const allow = new Set(readAllowList().map((e) => e.hash));
  const out: MaskSpan[] = [];
  const add = (s: number, e: number, kind: string, value: string) => {
    if (allow.has(allowHash(value)) || out.some((x) => s < x.e && e > x.s)) return;
    out.push({ kind, ph: placeholderFor(kind, value), s, e });
  };
  for (const sp of findSensitive(text, settings)) add(sp.start, sp.end, sp.kind, sp.value);
  for (const [value, k] of known) for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) add(i, i + value.length, k.kind, value);
  return out.sort((a, b) => a.s - b.s);
}

// ── 回程:换回 ──────────────────────────────────────────────────────────────────────────────────
const PH_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8})\s*\}\}/g;
const PH_MAX = 40;
export function restoreText(text: string, map: Map<string, string>): string {
  if (!map.size || !text.includes('{')) return text;
  return text.replace(PH_RE, (whole, body: string) => {
    const i = body.lastIndexOf('_');
    return map.get(`{{${body.slice(0, i).toUpperCase()}_${body.slice(i + 1).toLowerCase()}}}`) ?? whole;
  });
}
/** 流式文本末尾可能是半个占位符:从最后一个可能是开头的 `{` 起留着,等下一段。 */
function holdFrom(buf: string): number {
  const from = Math.max(0, buf.length - PH_MAX);
  for (let i = buf.indexOf('{', from); i >= 0; i = buf.indexOf('{', i + 1)) {
    if (/^\{\{?\s*[A-Za-z0-9_]*\s*\}?$/.test(buf.slice(i))) return i;
  }
  return buf.length;
}
export function createStreamRestorer(map: Map<string, string>) {
  let buf = '';
  return {
    push(delta: string): string {
      buf += delta;
      const cut = holdFrom(buf);
      const ready = buf.slice(0, cut);
      buf = buf.slice(cut);
      return restoreText(ready, map);
    },
    flush(): string { const r = restoreText(buf, map); buf = ''; return r; },
  };
}

// ── 包住 LlmBrain ───────────────────────────────────────────────────────────────────────────────
/** 脱敏没能运行(开着却出错)时抛这个:400 = 不重试;message 带 code 让界面认出来。 */
export const MASKING_FAILED = 'masking_failed';
/** 脱敏后的 payload 上挂一个不可枚举的回指(不进请求体):multiBrain 的 TANGU_LLM_DEBUG 按原 payload 对象挂标签。 */
export const MASKED_FROM = '__tangu_masked_from';
export const MASKING_BLOCKED = 'masking_blocked';

export function withOutboundMasking(llm: LlmBrain, settings: () => MaskSettings = maskSettings): LlmBrain {
  return {
    ...llm,
    streamProviderCompletion: async (opts: StreamOpts): Promise<StreamResult> => {
      const s = settings();
      if (!s.secrets && !s.personal) return llm.streamProviderCompletion(opts);
      let masked: MaskResult;
      try {
        masked = maskPayload(opts.payload, s);
      } catch (e) {
        throw new LlmError(400, `${MASKING_FAILED}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (masked.hits.length) {
        try { appendLog(opts.maskScope || '', s.action, masked.hits); } catch { /* 记录写不了不拦这一轮 */ }
        console.log(`[mask] ${s.action} ${masked.hits.length} value(s) before sending: ${[...new Set(masked.hits.map((h) => h.kind))].join(',')}`);
        opts.onMasked?.(masked.hits, s.action);
        if (s.action === 'block') {
          const h = masked.hits[0];
          throw new LlmError(400, `${MASKING_BLOCKED}: ${masked.hits.length} ${h.kind} ${h.head}… (${h.len})`);
        }
      }
      // 没遮任何东西(或只提醒):原 payload 原样发,不换副本
      if (s.action === 'warn' || !masked.map.size) return llm.streamProviderCompletion(opts);
      // 保留原 payload 的引用:multiBrain 的 TANGU_LLM_DEBUG 按 payload 对象挂标签
      Object.defineProperty(masked.payload, MASKED_FROM, { value: opts.payload, enumerable: false });
      const map = masked.map;
      const text = createStreamRestorer(map);
      const think = createStreamRestorer(map);
      const argsSeen = new Map<string, string>();
      const res = await llm.streamProviderCompletion({
        ...opts,
        payload: masked.payload,
        onToken: opts.onToken && ((d) => { const r = text.push(d); if (r) opts.onToken!(r); }),
        onReasoning: opts.onReasoning && ((d) => { const r = think.push(d); if (r) opts.onReasoning!(r); }),
        onToolCallDelta: opts.onToolCallDelta && ((info) => {
          const full = restoreText(info.args.slice(0, holdFrom(info.args)), map);
          const prev = argsSeen.get(info.id) ?? '';
          argsSeen.set(info.id, full);
          opts.onToolCallDelta!({ ...info, args: full, argsLen: full.length, argsDelta: full.startsWith(prev) ? full.slice(prev.length) : full });
        }),
      });
      const tail = text.flush();
      if (tail) opts.onToken?.(tail);
      const tTail = think.flush();
      if (tTail) opts.onReasoning?.(tTail);
      return {
        ...res,
        content: restoreText(res.content, map),
        reasoning: restoreText(res.reasoning, map),
        toolCalls: res.toolCalls.map((tc) => restoreToolCall(tc, map)),
      };
    },
  };
}
const tryJson = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };
/** 工具参数是 JSON 文本:解析后按叶子换回再序列化,值里的引号 / 换行才不会把 JSON 弄坏。解析不了就按文本换。 */
export function restoreArgs(args: string, map: Map<string, string>): string {
  if (!map.size || !args.includes('{{')) return args;
  const parsed = tryJson(args);
  if (parsed === undefined || typeof parsed !== 'object') return restoreText(args, map);
  const walk = (v: any): any => typeof v === 'string' ? restoreText(v, map)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return JSON.stringify(walk(parsed));
}
function restoreToolCall(tc: ToolCall, map: Map<string, string>): ToolCall {
  return { ...tc, function: { ...tc.function, arguments: restoreArgs(tc.function.arguments, map) } };
}
