/**
 * forsion:// deep link 主进程侧(View 基座统一化 P1)——**纯队列逻辑,零 Electron 依赖**(node 可测)。
 * 挂接(setAsDefaultProtocolClient / open-url / second-instance argv)在 main.ts;
 * 冷启动时 URL 先于渲染层就绪到达 → 入队,渲染层起来后经 IPC `deeplink:drain` 一次拉走。
 * 语义与安全边界正典:docs/ToBeImproved/View基座统一化方案_2026-08-25.md §4。
 */
import { statSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

/** 是不是我们的 scheme。只认形态,不做解析(解析与白名单在渲染层 resolver,那里有注册表)。 */
export const isForsionUrl = (s: unknown): s is string => typeof s === 'string' && /^forsion:\/\//i.test(s.trim())

const MAX_QUEUE = 8 // 防外部滥发挤爆:只留最近 8 条(deep link 是导航意图,旧的没意义)

const queue: string[] = []

export function pushDeepLink(url: string): void {
  if (!isForsionUrl(url)) return
  queue.push(url.trim())
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
}

/** 渲染层拉走全部待处理 URL(拿走即清)。 */
export function drainDeepLinks(): string[] {
  return queue.splice(0)
}

// ── 外部文件(Finder「打开方式」/ 拖到 Dock / win·linux 命令行参数)─────────────────────────
// 与 deep link 同形的冷启动队列;落点在渲染层(库外 → wsfile 临时标签页,不导入笔记库)。
// 与 forsion:// 分开走:deep link 是任意网页可达的输入,不许借它打开本机路径。

/** argv(调用方已切掉 [0] 的可执行文件)里哪些是要打开的文件:跳过开关与 forsion://、相对路径按 cwd 解析、
 *  只认存在的普通文件 —— dev / 台架的 argv 里有 app 根目录与 `--user-data-dir=…`,isFile 一刀切掉。
 *  file:// 也认:linux 的 .desktop 用 %U,文件管理器可能传 URL 而不是路径。 */
export function filesFromArgv(argv: string[], cwd: string): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (typeof a !== 'string' || !a || a.startsWith('-') || isForsionUrl(a)) continue
    try {
      const p = /^file:\/\//i.test(a) ? fileURLToPath(a) : resolve(cwd, a)
      if (statSync(p).isFile()) out.push(p)
    } catch { /* 不存在 / 无权限 / 坏 URL */ }
  }
  return out
}

const MAX_FILES = 32 // Finder 里多选一起打开是正常用法,封顶只为不无界
const files: string[] = []

export function pushOpenFile(p: string): void {
  if (typeof p !== 'string' || !p) return
  files.push(p)
  if (files.length > MAX_FILES) files.splice(0, files.length - MAX_FILES)
}

/** 渲染层拉走全部待打开文件(拿走即清)。 */
export function drainOpenFiles(): string[] {
  return files.splice(0)
}
