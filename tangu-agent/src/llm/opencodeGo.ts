/**
 * OpenCode 网关(opencode.ai:Go 订阅 / Zen 按量)的请求契约。
 *
 * 鉴权是 opencode.ai/console 里复制的 API key(Bearer),**不是**浏览器登录 —— 所以 OpenCode Go 是
 * 「设置 → 模型 → 添加连接」的一条预设(desktop providerPresets.ts),不进 OAUTH_PROVIDERS。
 *
 * Go 的硬要求(https://opencode.ai/v2/docs/console/go/ 「Where can I use it」,2026-11-05 探针实证):
 *   - 每段会话带稳定的 `x-opencode-session`。缺了直接 400 MissingSessionID,且先于鉴权检查 ——
 *     不带这个头,key 对不对都看不出来。
 *   - 用自己的 User-Agent 自报身份,别用通用 SDK / HTTP 库名(Node fetch 缺省就是 `node`)。
 * 门控按 hostname **全等** opencode.ai(同 isOfficialOpenAiHost,includes 会把 opencode.ai.evil.tld 认进来),
 * 不看路径:Zen 与 Go 同 host,OpenCode 自家客户端对两者都发这个头;base 路径改过一次(/zen/go/v1 →
 * /inference/go/...),按路径判反而容易漏。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 自报身份的 User-Agent(文档要求「my-coding-agent/1.0」这种形态)。 */
export const OPENCODE_USER_AGENT = 'forsion-tangu/1.0';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpenCodeHost(baseUrl: string | undefined): boolean {
  try {
    return new URL(baseUrl || '').hostname.toLowerCase() === 'opencode.ai';
  } catch {
    return false;
  }
}

/**
 * 会话键 → `x-opencode-session` 的值。同一个键永远同一个值(路由粘性 + 前缀缓存靠它)。
 * 会话 id 本身是 UUID 就直用;`<sid>:historian`、`<sid>:sub:<id>`、`btw:<sid>` 这类派生键哈希成 UUID 形状
 * (每条子线程各自稳定,且不把内部键的拼法发出去)。没有键时回退随机 —— 宁可这一次没有粘性,也不能不带头。
 * ponytail: 与 openaiResponses.stableSessionUuid 同算法;不直接 import 是为了不让 openaiCompat ⇄ openaiResponses 成环。
 */
export function openCodeSessionId(key: unknown): string {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return randomUUID();
  if (UUID_RE.test(k)) return k.toLowerCase();
  const h = createHash('md5').update(k).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** opencode.ai 上每个请求都要带的两个头。sessionKey 取会话键(没有就 run id,再没有就随机)。 */
export function buildOpenCodeHeaders(sessionKey?: unknown): Record<string, string> {
  return { 'x-opencode-session': openCodeSessionId(sessionKey), 'User-Agent': OPENCODE_USER_AGENT };
}
