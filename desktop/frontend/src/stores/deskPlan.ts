/** Agent Desk 纯决策(对标 sessionOpenPlan.ts:策略进纯函数可单测,appStore 只执行)。 */

/** Agent Desk 一格演出项。磁盘态=WsFileView/原生 view 渲染;live 存在=流式演出格(正在生成中的编辑,
 *  LivePane 直接订阅 toolEvent.arguments 渲染,不经 desk state 复制内容);view 存在=任意注册视图
 *  (含插件注册,按 type 查 LCL 注册表挂 shim leaf,此时 path='')。at=上台时刻(节流用)。 */
export interface DeskItem {
  key: string
  path: string
  name: string
  at: number
  live?: { msgId: string; toolId: string; tool: string }
  view?: { type: string; params?: Record<string, unknown> }
}

/** 编辑类工具:自动上台(tool_result)与流式直播(tool_stream)共用一份名单。 */
export const DESK_EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit'])

const ABS_RE = /^\/|^[A-Za-z]:[\\/]/

/** 编辑工具的目标路径 → 面板可读的绝对路径(相对路径拼 cwd;无 cwd 定位不了 → null)。 */
export function resolveDeskPath(raw: string, cwd?: string): string | null {
  const p = String(raw || '').trim()
  if (!p) return null
  if (ABS_RE.test(p)) return p
  if (!cwd) return null
  return cwd.replace(/[\\/]+$/, '') + '/' + p
}

/** 同文件 windowMs 内连续上台 → 跳过重挂(连打 edit_file 时预览抖动)。 */
export function isDuplicateShow(top: DeskItem | undefined, path: string, now: number, windowMs = 1500): boolean {
  return !!top && top.path === path && now - top.at < windowMs
}

/** 自动上台只替换顶格,保留 agent 显式摆的第二格。 */
export function replaceTop(items: DeskItem[] | undefined, item: DeskItem): DeskItem[] {
  return [item, ...(items || []).slice(1, 2)]
}

export function deskItemFor(path: string, now: number, name?: string): DeskItem {
  return { key: `${path}@${now}`, path, name: name || path.split(/[\\/]/).pop() || path, at: now }
}

/** 从**流式未完结**的 JSON 参数串里提取字符串字段的已到达前缀(Cursor 式直播的数据源)。
 *  匹配 `"key"\s*:\s*"`,随后逐字符解转义直到闭合引号或串尾;done=引号已闭合。
 *  key 未出现/值非字符串 → null。
 *  ponytail: 每次全量 O(n) 解析,超大 content 会二次方;卡了再上增量断点解析器。
 *  ponytail: indexOf 匹配首个键名,正文里出现同名串可能误中——实际参数键序(path 在前)使误中率≈0。 */
export function extractStreamingString(buf: string, key: string): { value: string; done: boolean } | null {
  const m = buf.match(new RegExp(`"${key}"\\s*:\\s*"`))
  if (!m || m.index === undefined) return null
  let i = m.index + m[0].length
  let out = ''
  while (i < buf.length) {
    const ch = buf[i]
    if (ch === '"') return { value: out, done: true }
    if (ch === '\\') {
      const nx = buf[i + 1]
      if (nx === undefined) break // 转义符悬空:等下一段 delta
      if (nx === 'n') out += '\n'
      else if (nx === 't') out += '\t'
      else if (nx === 'r') out += '\r'
      else if (nx === 'u') {
        const hex = buf.slice(i + 2, i + 6)
        if (hex.length < 4) break
        out += String.fromCharCode(parseInt(hex, 16) || 0)
        i += 6
        continue
      } else out += nx // \" \\ \/ …
      i += 2
      continue
    }
    out += ch
    i++
  }
  return { value: out, done: false }
}

/** 流式编辑的正文预览:write_file 看 content,edit_file/multi_edit 看(第一个)new_string。 */
export function extractLiveBody(args: string, tool: string): string {
  const key = tool === 'write_file' ? 'content' : 'new_string'
  return extractStreamingString(args, key)?.value ?? ''
}

/** 「正在编辑」事实:倒扫消息里未完结的编辑类 toolEvent,提取目标路径(参数可能尚未流完)。
 *  供 TaskSummary 的置顶入口;path 已按 cwd 解析。 */
/** Desk 会话快照持久化(localStorage,单键存全 map)。直播格是流式瞬态,落盘时剔除;
 *  空且无任何用户痕迹(fraction/mode/note)的条目不落;超容量按「最近展示时间」截断。 */
export const DESK_PERSIST_KEY = 'forsion.deskBySession'
export const DESK_PERSIST_CAP = 40

export interface DeskSnapshot {
  items: DeskItem[]
  size: 'half' | 'wide'
  mode?: 'open'
  fraction?: number
  userResized?: boolean
  note?: string
}

/** 条目新旧的代理:最近一次展示项的时间戳(无项=0,最先被截断)。 */
const snapAt = (s: DeskSnapshot): number => Math.max(0, ...s.items.map((it) => it.at || 0))

export function packDeskMap(map: Record<string, DeskSnapshot>, cap = DESK_PERSIST_CAP): string {
  const entries = Object.entries(map)
    .map(([sid, s]) => [sid, { ...s, items: (s.items || []).filter((it) => !it.live && (it.path || it.view)) }] as const)
    .filter(([, s]) => s.items.length || s.fraction !== undefined || s.userResized || s.mode || s.note)
    .sort((a, b) => snapAt(b[1]) - snapAt(a[1]))
    .slice(0, cap)
  return JSON.stringify(Object.fromEntries(entries))
}

export function unpackDeskMap(raw: string | null | undefined): Record<string, DeskSnapshot> {
  if (!raw) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object') return {}
  const out: Record<string, DeskSnapshot> = {}
  for (const [sid, v] of Object.entries(parsed as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue
    const items: DeskItem[] = (Array.isArray(v.items) ? v.items : [])
      .filter((it: any) => it && !it.live
        && ((typeof it.path === 'string' && it.path) || (it.view && typeof it.view.type === 'string' && it.view.type)))
      .slice(0, 2)
      .map((it: any) => ({
        key: typeof it.key === 'string' ? it.key : `${it.path || it.view.type}@0`,
        path: typeof it.path === 'string' ? it.path : '',
        name: typeof it.name === 'string' && it.name ? it.name : (it.path || it.view.type).split(/[\\/]/).pop() || it.path || it.view.type,
        at: typeof it.at === 'number' ? it.at : 0,
        ...(it.view && typeof it.view.type === 'string' && it.view.type
          ? { view: { type: it.view.type, ...(it.view.params && typeof it.view.params === 'object' && !Array.isArray(it.view.params) ? { params: it.view.params } : {}) } }
          : {}),
      }))
    out[sid] = {
      items,
      size: v.size === 'wide' ? 'wide' : 'half',
      ...(v.mode === 'open' ? { mode: 'open' as const } : {}),
      ...(typeof v.fraction === 'number' && v.fraction > 0 && v.fraction < 1 ? { fraction: v.fraction } : {}),
      ...(v.userResized ? { userResized: true } : {}),
      ...(typeof v.note === 'string' && v.note ? { note: v.note } : {}),
    }
  }
  return out
}

export function findLiveEdit(
  messages: Array<{ toolEvents?: Array<{ id: string; name: string; arguments?: string; done?: boolean }> }>,
  cwd?: string,
): { path: string; name: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const evs = messages[i].toolEvents
    if (!evs) continue
    for (let j = evs.length - 1; j >= 0; j--) {
      const e = evs[j]
      if (e.done || !DESK_EDIT_TOOLS.has(e.name)) continue
      const raw = extractStreamingString(e.arguments || '', 'path')
      const p = raw ? resolveDeskPath(raw.value, cwd) : null
      if (p) return { path: p, name: p.split(/[\\/]/).pop() || p }
      return null // 找到进行中的编辑但路径还没流出来:本轮先不显示
    }
  }
  return null
}
