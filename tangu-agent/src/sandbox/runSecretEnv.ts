/**
 * 每次 run 的秘密环境变量(POST /agent/runs 的 secret_env)。
 *
 * 用途:插件把平台登录信息(如青鸟的 BLUEBIRD_COOKIE)交给它让 Agent 跑的脚本,而模型一个字都看不到。
 *  - 只在内存里:不进 run.input、不落库、不进提示词;run 结束(runLoop finally)即删,另有 TTL 兜底(排队中被取消、从未开跑的 run)。
 *  - 只给本 run 自己的 run_bash 子进程(按 ctx.runId 取);派生 run(团队 / 子代理 / 讨论)有自己的 runId,不继承。
 *  - 远程来源(x-forsion-remote)的 run 一律不收。
 *  - run_bash 的输出在交还模型之前把这些值替换成 [REDACTED:<名字>](脚本万一把它打印出来也不会进上下文)。
 */

const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_KEYS = 8;
const MAX_VALUE = 16_384;
const MIN_REDACT = 8; // 太短的值做替换会误伤正常输出;秘密本来也不会这么短
const TTL_MS = 6 * 60 * 60 * 1000;
/** 进程自身的关键变量不许被覆盖。 */
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);

const store = new Map<string, { env: Record<string, string>; at: number }>();

/** 校验请求体里的 secret_env。不合法 → null(调用方按 400 处理);缺省 / 空对象 → {}。 */
export function normalizeSecretEnv(raw: unknown): Record<string, string> | null {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_KEYS) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!NAME_RE.test(k) || RESERVED.has(k) || k.startsWith('TANGU_') || k.startsWith('FORSION_')) return null;
    if (typeof v !== 'string' || v.length > MAX_VALUE || v.includes('\0')) return null;
    if (!v.trim()) continue;
    out[k] = v;
  }
  return out;
}

function sweep(now = Date.now()): void {
  for (const [id, e] of store) if (now - e.at > TTL_MS) store.delete(id);
}

export function setRunSecretEnv(runId: string, env: Record<string, string>): void {
  sweep();
  if (!runId || !Object.keys(env).length) return;
  store.set(runId, { env: { ...env }, at: Date.now() });
}

export function clearRunSecretEnv(runId: string | undefined): void {
  if (runId) store.delete(runId);
}

/** 本 run 的秘密变量(远程 run 永远是空)。返回拷贝。 */
export function runSecretEnv(ctx: { runId?: string; remote?: unknown } | undefined): Record<string, string> {
  if (!ctx?.runId || ctx.remote) return {};
  const e = store.get(ctx.runId);
  return e ? { ...e.env } : {};
}

/** 把本 run 的秘密值从文本里抹掉。长的先替换,免得短值是长值的一部分时留下半截。 */
export function redactRunSecrets(ctx: { runId?: string } | undefined, text: string): string {
  if (!text || !ctx?.runId) return text;
  const e = store.get(ctx.runId);
  if (!e) return text;
  let out = text;
  for (const [k, v] of Object.entries(e.env).sort((a, b) => b[1].length - a[1].length)) {
    const value = v.trim();
    if (value.length < MIN_REDACT) continue;
    out = out.split(value).join(`[REDACTED:${k}]`);
  }
  return out;
}

/** 测试用 */
export function _resetRunSecretEnv(): void { store.clear(); }
