/**
 * `ctx.app.onVaultEvent` 的底座:库里的文件新建 / 删除 / 改名 / 外部修改,攒成批交给插件。
 *
 * 不另起文件监听,三路现成的信号合起来:
 *   - 新建 / 删除 = pageStore 的笔记 + 文件清单前后比对(应用内操作与外部增删都会刷新这份清单);
 *   - 改名 / 移动 = onNotePathGone(应用里任何窗口的改名,带新旧路径;文件夹整棵挪 = folder: true)——
 *     同一次改名在清单比对里表现为「旧的删、新的建」,这两条按改名的新旧路径滤掉,只报一条 rename;
 *   - 修改 = 主进程的外部改动广播(笔记 / .db / 其余文件):别的程序、Agent、别的窗口、同步写的。
 *     本窗编辑器里的打字不算(当前页用 ctx.app.subscribePage)。
 * 换库报一条 `vault`(清单整体换了,插件自己重读),不把两个库的差当成成千条增删。
 * 接线是懒的:第一个订阅者出现才挂,最后一个走了就摘。
 */
import { amadeus } from '../api'
import { onNotePathGone, usePageStore } from '../store/pageStore'
import type { PluginVaultEvent } from './types'

type Listener = (events: PluginVaultEvent[]) => void

const BATCH_MS = 200
/** 改名之后多久内,清单比对里对应的删 / 建算作这次改名(主进程的结构刷新有 300ms 防抖,留足余量)。 */
const RENAME_SUPPRESS_MS = 5000

const listeners = new Set<Listener>()
let offs: Array<() => void> = []
let queue: PluginVaultEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let baseRoot: string | null = null
let baseline: Set<string> | null = null
/** 改名涉及的确切路径 → 失效时刻(文件夹改名展开成里面每个文件,新建进新文件夹的文件不受影响)。 */
const renamedFrom = new Map<string, number>()
const renamedTo = new Map<string, number>()

const norm = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '')

function covered(map: Map<string, number>, p: string, now: number): boolean {
  for (const [k, exp] of map) if (exp < now) map.delete(k)
  return map.has(p)
}

function push(e: PluginVaultEvent): void {
  queue.push(e)
  timer ??= setTimeout(flush, BATCH_MS)
}

function flush(): void {
  timer = null
  const now = Date.now()
  const seen = new Set<string>()
  const batch = queue.filter((e) => {
    if (e.kind === 'create' && covered(renamedTo, e.path, now)) return false
    if (e.kind === 'delete' && covered(renamedFrom, e.path, now)) return false
    // 只合并 modify(同一批里同一个文件改了几次,报一次)和 vault;建 / 删 / 改名按发生顺序原样报,合并会改掉最终状态
    if (e.kind !== 'modify' && e.kind !== 'vault') return true
    const key = e.kind === 'vault' ? 'vault' : e.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  queue = []
  if (!batch.length) return
  for (const f of Array.from(listeners)) {
    try { f(batch) } catch (err) { console.error('[amadeus] onVaultEvent 回调抛错', err) }
  }
}

type St = ReturnType<typeof usePageStore.getState>
/** 清单还没装完(切库 / 打开时 files 先清空再补)= 没有可比的基线。 */
const listing = (st: St): Set<string> | null => (st.filesPendingFor ? null : new Set([...st.pages, ...st.files].map(norm)))

function onStore(st: St, prev: St): void {
  if (st.pages === prev.pages && st.files === prev.files && st.vaultRoot === prev.vaultRoot && st.filesPendingFor === prev.filesPendingFor) return
  if (st.vaultRoot !== baseRoot) {
    baseRoot = st.vaultRoot
    baseline = listing(st)
    queue = [] // 旧库还没发出去的路径事件和改名记录作废:插件收到 vault 自己重读
    renamedFrom.clear()
    renamedTo.clear()
    push({ kind: 'vault' })
    return
  }
  const now = listing(st)
  if (!now) return
  if (!baseline) { baseline = now; return } // 装完的第一份清单只当基线
  for (const p of now) if (!baseline.has(p)) push({ kind: 'create', path: p })
  for (const p of baseline) if (!now.has(p)) push({ kind: 'delete', path: p })
  baseline = now
}

function wire(): void {
  const st = usePageStore.getState()
  baseRoot = st.vaultRoot
  baseline = listing(st)
  const modify = (p: string): void => { const path = norm(p); if (path) push({ kind: 'modify', path }) }
  offs = [
    usePageStore.subscribe(onStore),
    onNotePathGone((from, kind, to) => {
      if (!to) return // 删除由清单比对报
      const f = norm(from), t = norm(to), exp = Date.now() + RENAME_SUPPRESS_MS
      const pair = (a: string, b: string) => { renamedFrom.set(a, exp); renamedTo.set(b, exp) }
      if (kind !== 'prefix') pair(f, t)
      // 文件夹:按清单展开成挪动的那些文件。清单可能还是旧的(广播先到)也可能已是新的(清单先到),两头都认
      else for (const p of baseline ?? []) {
        if (p.startsWith(`${f}/`)) pair(p, t + p.slice(f.length))
        else if (p.startsWith(`${t}/`)) pair(f + p.slice(t.length), p)
      }
      push({ kind: 'rename', path: t, from: f, ...(kind === 'prefix' ? { folder: true } : {}) })
    }),
    ...[amadeus?.onExternalChange?.(modify), amadeus?.onDbExternalChange?.(modify), amadeus?.onFileExternalChange?.(modify)]
      .filter((off): off is () => void => typeof off === 'function'),
  ]
}

function unwire(): void {
  for (const off of offs) { try { off() } catch { /* ignore */ } }
  offs = []
  if (timer) clearTimeout(timer)
  timer = null
  queue = []
  baseline = null
  renamedFrom.clear()
  renamedTo.clear()
}

export function subscribeVaultEvents(cb: Listener): () => void {
  if (typeof cb !== 'function') return () => {}
  if (!listeners.size) wire()
  listeners.add(cb)
  return () => {
    if (!listeners.delete(cb)) return
    if (!listeners.size) unwire()
  }
}
