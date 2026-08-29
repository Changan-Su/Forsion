/**
 * 上下文窗口的**自动识别**层 —— 手写族表(contextBudget 的 FAMILY_WINDOWS)之外的证据源。
 *
 * 背景:窗口值是四个阈值的分母(入站 25%/50% 闸门、50% 机械折叠、95% 强制压缩)与界面进度环。
 * 此前它只有「手写族表 + 128k 兜底」两档:族表没收录的新模型一律按 128k 算,64k 就开始绞上下文;
 * 而族表收录错了(报大了)则是另一头 —— 直接撞 provider 溢出、整轮请求失败。
 *
 * 这里加的是**回学**:上游拒收超长 prompt 时,报错文案里几乎总会写明真实上限
 * (OpenAI「maximum context length is N tokens」/ Anthropic「N tokens > M maximum」)。
 * 那是**该 key、该部署**上的实际限制,比任何目录数字都准。学到就落盘,下次请求直接用。
 *
 * 三条不变量(测试钉死):
 *   1. **只调小,不调大**。估值偏小只会早折叠(自愈),永远走不到 provider 的上限、也就学不到东西;
 *      所以「溢出」这件事本身就意味着估值 > 真实值。允许调大等于把「目录里的总窗口」当成输入预算
 *      (gpt-5 族总窗 400k、输入上限只有 272k —— 族表存的是后者,调大会把它顶回 400k 再撞一次)。
 *   2. **手动永远优先**:env 覆盖 / admin 在模型上填的窗口都压过学到的值。学到的值与人填的冲突时,
 *      不静默改人的配置,只体现在 source 标注上。
 *   3. **脏值不入库**:只认 400/413 + 解析出的数在 [4k, 10M] 区间内,否则宁可不学。
 *
 * ponytail: 学到的值**不过期**,也没有界面上的清除入口。厂商事后**调大**窗口时(Anthropic 一代之内
 * 就从 200k 提到过 1M),不变量①会拒绝这次调大,旧的小值会一直留着。今天的逃生口是 env 覆盖
 * `TANGU_MODEL_CONTEXT_WINDOWS` 或手删本文件。要根治:条目带上 learnedAt,超过 N 天降级为参考值,
 * 或在设置里露一个「清空自动识别到的窗口」按钮。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';

const file = (): string => join(tanguHome(), 'context-windows.json');

/** 合理区间:比 4k 小的不像窗口(多半是别的数字),比 10M 大的今天还不存在。 */
const MIN_TOKENS = 4_000;
const MAX_TOKENS = 10_000_000;

/**
 * 上游报错里的「真实上限」。**只收真实见过的措辞**——多认一种没见过的句式,
 * 就是多一种把无关数字学成窗口的机会(误学的方向是把估值调小,虽不致命但会白白早折叠)。
 */
const PATTERNS: readonly RegExp[] = [
  /maximum context length is\s+(\d+)/i, // OpenAI 及大量兼容实现
  />\s*(\d+)\s*maximum/i, // Anthropic:「prompt is too long: N tokens > M maximum」
];

/** 从上游错误文案里抠出真实上限;认不出返回 undefined(认不出是安全的,乱认才危险)。 */
export function parseContextLimit(detail: string | undefined): number | undefined {
  const text = String(detail || '');
  if (!text) return undefined;
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= MIN_TOKENS && n <= MAX_TOKENS) return Math.floor(n);
  }
  return undefined;
}

let cache: Record<string, number> | null = null;
/** 单测模式:只在内存里学,绝不碰真家目录(否则跑一次测试就往用户 ~/.tangu 里塞测试数据)。 */
let memoryOnly = false;

function load(): Record<string, number> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    const out: Record<string, number> = {};
    for (const k of Object.keys(raw || {})) {
      const v = Number(raw[k]);
      if (Number.isFinite(v) && v >= MIN_TOKENS && v <= MAX_TOKENS) out[k] = Math.floor(v);
    }
    cache = out;
  } catch {
    cache = {}; // 没有文件 / 文件坏了都当空表——这是可重新学到的缓存,不是真源
  }
  return cache;
}

/** 落盘尽力而为:临时文件 + rename,失败不影响本次运行(内存里的值照样生效)。 */
function persist(): void {
  if (!cache || memoryOnly) return;
  try {
    mkdirSync(tanguHome(), { recursive: true });
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    renameSync(tmp, file());
  } catch {
    /* 只读家目录 / 磁盘满:学到的值本轮仍可用,下次重新学 */
  }
}

/** 学到的窗口(没学到返回 undefined)。 */
export function learnedWindow(modelId: string | undefined | null): number | undefined {
  const id = String(modelId || '').trim();
  return id ? load()[id] : undefined;
}

/**
 * 从上游报错里回学。返回学到的值(没学到 undefined)。
 * @param status HTTP 状态码 —— 只有 400/413 才可能是「超长被拒」,其它状态里的数字不能信。
 */
export function learnFromUpstreamError(
  modelId: string | undefined | null,
  status: number,
  detail: string | undefined,
): number | undefined {
  const id = String(modelId || '').trim();
  if (!id || (status !== 400 && status !== 413)) return undefined;
  const n = parseContextLimit(detail);
  if (!n) return undefined;
  const store = load();
  // 不变量①:只调小。已经学到过更小的值就保留更小的那个(不同 key/部署可能限得更死)。
  if (store[id] != null && store[id] <= n) return store[id];
  store[id] = n;
  persist();
  return n;
}

/** 单测用:清空内存表(各用例互不污染;不碰磁盘)。 */
export function resetContextWindowStoreForTest(seed?: Record<string, number>): void {
  cache = seed ? { ...seed } : {};
  memoryOnly = true;
}
