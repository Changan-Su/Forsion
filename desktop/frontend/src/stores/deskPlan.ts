/** Agent Desk 纯决策(对标 sessionOpenPlan.ts:策略进纯函数可单测,appStore 只执行)。 */
import { contentStorageKey } from '@lcl/engine/contentStorageScope'

/** Agent Desk 一格演出项。磁盘态=WsFileView/原生 view 渲染;live 存在=流式演出格(正在生成中的编辑,
 *  LivePane 直接订阅 toolEvent.arguments 渲染,不经 desk state 复制内容);view 存在=任意注册视图
 *  (含插件注册,按 type 查 LCL 注册表挂 shim leaf,此时 path='')。at=上台时刻(节流用)。 */
export interface DeskItem {
  key: string
  path: string
  name: string
  at: number
  /** bumped:直播期间因它下了台的那一格(只在内存里;直播条目整条不落快照)。直播失败清场时请回来,
   *  路径就位时若下格正是这份文件的旧版,也拿它换回下格(见 placeLiveItem / clearLiveTop)。 */
  live?: { msgId: string; toolId: string; tool: string; bumped?: DeskItem }
  view?: { type: string; params?: Record<string, unknown> }
  /** 插件工具结果卡片(落点 desk):按调用 id 回到这条会话的消息里找那次调用(components/PluginToolCard.tsx)。 */
  tool?: { callId: string }
  /** 这一格被用户钉住(11-23 方案 A):用户动过手的格子,Agent 的新东西不再进它。只写 true、不写 false;
   *  字段跟着条目走(换位时随条目一起挪)。以后格子有了归属(你的 / Agent 的)就从这里长出来,别改成全局开关。 */
  pin?: true
}

/** 编辑类工具:自动上台(tool_result)与流式直播(tool_stream)共用一份名单。 */
export const DESK_EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit'])

const ABS_RE = /^\/|^[A-Za-z]:[\\/]/
/** Agent 写文件的全部工具(评审 G3-03:打开着的笔记被 Agent 改了要能认出来)。比 DESK_EDIT_TOOLS 多一个
 *  apply_patch —— 它的路径藏在补丁正文里,Desk 的直播格按 `path` 字段取不到,所以**不并进** DESK_EDIT_TOOLS
 *  (并进去 = Desk 为每个 apply_patch 弹一个没有路径的空直播卡)。与引擎 tools/writeTargets.ts 的 WRITE_TOOLS 同表。 */
export const AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([...DESK_EDIT_TOOLS, 'apply_patch'])

// 补丁里的目标路径:File: / Move to: 行(照抄引擎 tools/writeTargets.ts 的 PATCH_PATH_RE,含改名的新路径)。
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm

/** 同 agentWriteTargets,但带上可核对盘上正文的特征(Codex 复核 P0 ③,归属账本用):write_file 带完整内容,
 *  edit_file / multi_edit 带各处 new_string;apply_patch 只给路径(补丁的上下文行对不出整段正文,不硬凑)。 */
export function agentWriteChecks(tool: string, argsJson: string | undefined, cwd?: string): Array<{ path: string; full?: string; includes?: string[] }> {
  const paths = agentWriteTargets(tool, argsJson, cwd)
  if (!paths.length || tool === 'apply_patch') return paths.map((path) => ({ path }))
  let args: Record<string, unknown> = {}
  try { args = argsJson ? JSON.parse(argsJson) : {} } catch { return [] }
  const str = (v: unknown): v is string => typeof v === 'string'
  if (tool === 'write_file') return paths.map((path) => (str(args.content) ? { path, full: args.content } : { path }))
  const news = tool === 'multi_edit'
    ? (Array.isArray(args.edits) ? args.edits : []).map((e) => (e as Record<string, unknown>)?.new_string).filter(str)
    : [args.new_string].filter(str)
  return paths.map((path) => ({ path, includes: news }))
}

/** 一次写类工具调用的全部目标路径(已按 cwd 解析成绝对路径;定位不了的丢掉)。参数必须是**完整** JSON。 */
export function agentWriteTargets(tool: string, argsJson: string | undefined, cwd?: string): string[] {
  if (!AGENT_WRITE_TOOLS.has(tool)) return []
  let args: Record<string, unknown> = {}
  try { args = argsJson ? JSON.parse(argsJson) : {} } catch { return [] }
  const raw: string[] = []
  if (tool === 'apply_patch') {
    const patch = String(args.patch ?? args.input ?? '')
    PATCH_PATH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATCH_PATH_RE.exec(patch))) raw.push((m[1] || m[2] || '').trim())
  } else if (typeof args.path === 'string') raw.push(args.path)
  return raw.map((p) => resolveDeskPath(p, cwd)).filter((p): p is string => !!p)
}


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

/** 「同一份文件」比较用的路径归一(纯字符串:不读盘、不碰大小写)—— 反斜杠转正斜杠,折叠 `//` 与 `/./`,
 *  消掉 `..`,去尾部斜杠。只用于比较:条目的 path / key 照旧存 resolveDeskPath 的原样结果(读文件、快照都用它)。 */
export function deskPathId(p: string): string {
  const s = String(p || '').replace(/\\/g, '/')
  if (!s) return ''
  const abs = s.startsWith('/')
  const drive = (x: string | undefined): boolean => !!x && /^[A-Za-z]:$/.test(x)
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      const last = out[out.length - 1]
      if (last !== undefined && last !== '..' && !drive(last)) out.pop()
      else if (!abs && !drive(last)) out.push('..') // 相对路径开头的 .. 留着;根 / 盘符之上没有上一级
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** 两个路径是不是同一份文件:都非空且归一后相等。 */
const samePath = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && deskPathId(a) === deskPathId(b)

/** 两个条目是不是同一份文件:path 非空且归一后相等。view 条目、插件工具卡条目的 path 是空串,永不算同一份。 */
export function sameDeskFile(a: DeskItem | undefined, b: DeskItem | undefined): boolean {
  return samePath(a?.path, b?.path)
}

/** 自动上台只替换顶格,第二格(agent 显式摆的 / 用户经 ▾ 换下去的)照旧保留 ——
 *  除非第二格正是新条目这份文件的旧版:两格不演同一份文件,改留原顶格;原顶格是直播格时改看它的 bumped
 *  (被顶替的直播本身不落到第二格)。留的那格也是这份文件 / 没有可留的 → 只剩一格。 */
export function replaceTop(items: DeskItem[] | undefined, item: DeskItem): DeskItem[] {
  const [top, second] = items || []
  if (!second) return [item]
  if (!sameDeskFile(second, item)) return [item, second]
  const keep = top?.live ? top.live.bumped : top
  return keep && !keep.live && !sameDeskFile(keep, item) ? [item, keep] : [item]
}

const withBumped = (item: DeskItem, bumped: DeskItem | undefined): DeskItem =>
  bumped && item.live ? { ...item, live: { ...item.live, bumped } } : item

/** 直播格上台 / 更新(bumped 的口径见 DeskItem.live):
 *  - 顶格已是同一次调用(同 toolId)的直播格 → 原地换掉(key 不变不重挂),bumped 带下去,其余照留;
 *    路径刚就位时下格若正是这份文件的旧版 → 拿 bumped 换回下格(bumped 得是别的文件),旧版改记为 bumped。
 *  - 否则按 replaceTop 进顶格,并记下因此下台的那一格。顶替的是另一次调用的直播格时(一轮里连发两个编辑),
 *    继承它的 bumped 当候选;直播格本身永不记成 bumped。 */
export function placeLiveItem(items: DeskItem[] | undefined, item: DeskItem): DeskItem[] {
  const cur = items || []
  const top = cur[0]
  if (!item.live) return replaceTop(cur, item)
  if (top?.live?.toolId === item.live.toolId) {
    let bumped = top.live.bumped
    const rest = cur.slice(1).flatMap((x) => {
      if (!sameDeskFile(x, item)) return [x]
      const back = bumped && !sameDeskFile(bumped, item) ? bumped : undefined
      bumped = x
      return back ? [back] : []
    })
    return [withBumped(item, bumped), ...rest]
  }
  const placed = replaceTop(cur, item)
  const prior = top?.live ? [top.live.bumped, cur[1]] : cur.slice(0, 2)
  const off = prior.find((x): x is DeskItem => !!x && !x.live && !placed.includes(x))
  return [withBumped(item, off), ...placed.slice(1)]
}

/** 直播格清场(失败 / 没落成):只认顶格是这次调用的直播格(不是 → null,不动);
 *  带着 bumped → 还原成 [bumped, ...其余],否则只去掉顶格。 */
export function clearLiveTop(items: DeskItem[] | undefined, toolId: string): DeskItem[] | null {
  const top = items?.[0]
  if (!items || !top?.live || top.live.toolId !== toolId) return null
  return top.live.bumped ? [top.live.bumped, ...items.slice(1)] : items.slice(1)
}

/** 顶格是直播格时点了一份文件:正是直播格那份、或正是下格那份(它已经在 Desk 上)→ 条目原样不动。
 *  按归一后的路径比;被点的路径为空一律不算。 */
export function liveKeepsDesk(items: DeskItem[] | undefined, path: string): boolean {
  const [top, second] = items || []
  return !!top?.live && (samePath(top.path, path) || samePath(second?.path, path))
}

/** 直播格的目标路径:path 字段闭合(done)之前不认 —— 路径分段流出时,前半截会被当成完整路径钉进
 *  条目且再也不更新(「正在编辑 fo」)。没闭合 / 定位不了 → null。 */
export function liveDeskPath(args: string, cwd?: string): string | null {
  const raw = extractStreamingString(args, 'path')
  return raw?.done ? resolveDeskPath(raw.value, cwd) : null
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
export const DESK_PERSIST_KEY = contentStorageKey('forsion.deskBySession')
/** Human Desk 的快照(humanDeskPlan.ts 用;放这里是为了 Tangu 那侧不再多一条对 LCL 存储作用域的依赖,check:tanguboundary)。 */
export const HUMAN_DESK_PERSIST_KEY = contentStorageKey('forsion.humanDeskBySession')
export const DESK_PERSIST_CAP = 40

/** 旧版新会话草稿 Desk 的保留键;ChatView 现在只在会话开始后挂载 Desk。
 *  保留落盘过滤与组件兼容,避免旧草稿状态进入会话快照。 */
export const DESK_DRAFT_KEY = '__draft__'

export interface DeskSnapshot {
  items: DeskItem[]
  size: 'half' | 'wide'
  mode?: 'open'
  fraction?: number
  userResized?: boolean
  note?: string
  /** 下面这几项见 DeskCore(手动控制,11-23 方案 A)。split = 上格占的比例(缺省各半)。 */
  noteFor?: string[]
  recent?: DeskItem[]
  fresh?: string
  solo?: number
  split?: number
}

/** 条目新旧的代理:最近一次展示项的时间戳(无项=0,最先被截断)。 */
const snapAt = (s: DeskSnapshot): number => Math.max(0, ...s.items.map((it) => it.at || 0))

const persistable = (it: DeskItem): boolean => !it.live && !!(it.path || it.view || it.tool)

export function packDeskMap(map: Record<string, DeskSnapshot>, cap = DESK_PERSIST_CAP): string {
  const entries = Object.entries(map)
    .map(([sid, s]) => {
      const recent = (s.recent || []).filter(persistable)
      // 钉住格里的直播(两格都钉时点「正在编辑」请进来的):落盘它顶掉的那样(带钉住),别把钉住的格从快照里丢了
      const items = (s.items || []).map((it) => (it.live && it.pin && it.live.bumped ? { ...unpinned(it.live.bumped), pin: true as const } : it))
      const out: DeskSnapshot = { ...s, items: items.filter(persistable) }
      if (recent.length) out.recent = recent; else delete out.recent
      if (out.fresh?.startsWith('live:')) delete out.fresh // 直播的那颗点是瞬态,同直播格一样不落盘
      return [sid, out] as const
    })
    .filter(([sid, s]) => sid !== DESK_DRAFT_KEY && (s.items.length || s.fraction !== undefined || s.userResized || s.mode || s.note || s.recent?.length || s.split !== undefined))
    .sort((a, b) => snapAt(b[1]) - snapAt(a[1]))
    .slice(0, cap)
  return JSON.stringify(Object.fromEntries(entries))
}

/** 快照里的一个条目 → DeskItem(畸形 / 直播 → null)。 */
function unpackItem(it: any): DeskItem | null {
  if (!it || it.live) return null
  const view = it.view && typeof it.view.type === 'string' && it.view.type ? it.view : null
  const callId = it.tool && typeof it.tool.callId === 'string' && it.tool.callId ? it.tool.callId : null
  if (!((typeof it.path === 'string' && it.path) || view || callId)) return null
  const id = it.path || view?.type || callId
  return {
    key: typeof it.key === 'string' ? it.key : `${id}@0`,
    path: typeof it.path === 'string' ? it.path : '',
    name: typeof it.name === 'string' && it.name ? it.name : String(id).split(/[\\/]/).pop() || id,
    at: typeof it.at === 'number' ? it.at : 0,
    ...(callId ? { tool: { callId } } : {}),
    ...(view ? { view: { type: view.type, ...(view.params && typeof view.params === 'object' && !Array.isArray(view.params) ? { params: view.params } : {}) } } : {}),
    ...(it.pin === true ? { pin: true as const } : {}),
  }
}

export function unpackDeskMap(raw: string | null | undefined): Record<string, DeskSnapshot> {
  if (!raw) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object') return {}
  const out: Record<string, DeskSnapshot> = {}
  for (const [sid, v] of Object.entries(parsed as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue
    const parse = (xs: unknown, cap: number): DeskItem[] =>
      (Array.isArray(xs) ? xs : []).map(unpackItem).filter((x): x is DeskItem => !!x).slice(0, cap)
    const items = parse(v.items, 2)
    const recent = parse(v.recent, DESK_RECENT_CAP).map(unpinned)
    const noteFor = Array.isArray(v.noteFor) ? v.noteFor.filter((x: unknown): x is string => typeof x === 'string') : null
    out[sid] = {
      items,
      size: v.size === 'wide' ? 'wide' : 'half',
      ...(v.mode === 'open' ? { mode: 'open' as const } : {}),
      ...(typeof v.fraction === 'number' && v.fraction > 0 && v.fraction < 1 ? { fraction: v.fraction } : {}),
      ...(v.userResized ? { userResized: true } : {}),
      ...(typeof v.note === 'string' && v.note ? { note: v.note } : {}),
      ...(noteFor ? { noteFor } : {}),
      ...(recent.length ? { recent } : {}),
      ...(typeof v.fresh === 'string' && v.fresh && !v.fresh.startsWith('live:') ? { fresh: v.fresh } : {}),
      ...(v.solo === 0 || v.solo === 1 ? { solo: v.solo } : {}),
      ...(typeof v.split === 'number' && Number.isFinite(v.split) ? { split: clampSplit(v.split) } : {}),
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
      const p = liveDeskPath(e.arguments || '', cwd)
      if (p) return { path: p, name: p.split(/[\\/]/).pop() || p }
      return null // 找到进行中的编辑但路径还没流完:本轮先不显示(不出半截名字)
    }
  }
  return null
}

// ── 手动控制(2026-11-23 用户选方案 A,方案页 docs/ToBeImproved/AgentDesk手动控制方案_2026-11-20/) ──
// 每格可钉住(DeskItem.pin):用户动过手的格子(换内容、对调、拖进东西)自动钉住,Agent 的新东西(编辑自动上台、
// 流式直播、desk_present)只进没钉的那格;两格都钉了就不顶替,只在 ▾ 上亮点(fresh)。一格都没钉时
// 一律走上面 #790 的那几个函数(replaceTop / placeLiveItem / clearLiveTop / liveKeepsDesk),行为与之前逐字一致。
// 所有往 Desk 上放东西的入口都经 deskReduce,不然钉住的格会被绕过去改掉、「最近放过的」也记不全。

export const DESK_RECENT_CAP = 8
export const DESK_SPLIT_MIN = 0.2
export const DESK_SPLIT_MAX = 0.8
/** 上下分界的比例(上格占比),夹在 20%–80%。按比例存,跟界面缩放无关。 */
export const clampSplit = (f: number): number => Math.min(DESK_SPLIT_MAX, Math.max(DESK_SPLIT_MIN, f))

/** 条目的身份:文件按归一后的路径(同一份文件 = 同一样);插件工具卡按调用 id;注册视图按 key。 */
export function deskIdentity(it: DeskItem): string {
  return it.path ? `f:${deskPathId(it.path)}` : it.tool ? `t:${it.tool.callId}` : `k:${it.key}`
}
const sameThing = (a: DeskItem | undefined, b: DeskItem | undefined): boolean => !!a && !!b && deskIdentity(a) === deskIdentity(b)
function unpinned(it: DeskItem): DeskItem {
  if (!it.pin) return it
  const { pin: _pin, ...rest } = it
  return rest
}
const pinnedAs = (it: DeskItem, pin: boolean | undefined): DeskItem => (pin ? { ...it, pin: true } : unpinned(it))
const hasPins = (items: DeskItem[]): boolean => items.some((x) => x.pin)
const setAt = (items: DeskItem[], i: number, it: DeskItem): DeskItem[] => (i < items.length ? items.map((x, j) => (j === i ? it : x)) : [...items, it])
const dropAt = (items: DeskItem[], i: number): DeskItem[] => items.filter((_, j) => j !== i)

/** Desk 上与「摆法」有关的那部分状态(两窗口同步、快照、卡片都看它)。 */
export interface DeskCore {
  items: DeskItem[]
  /** 这条会话在 Desk 上最近放过的(最新在前,≤8,不含直播格,不带 pin)。 */
  recent?: DeskItem[]
  /** Agent 放了但你看不见的那一样(两格都钉了 / 进了收起的那格):▾ 上亮点、列表顶上「Agent 刚放的」。
   *  值是 deskIdentity;`live:<toolId>` = 两格都钉着时 Agent 正在写(直播没上台),不落盘。打开 ▾ 即清。 */
  fresh?: string
  /** 只看这一格:看哪一格(下标)。只有两格时才有意义。 */
  solo?: number
  note?: string
  /** desk_present 那句说明对应的条目身份:这些都不在 Desk 上了,说明跟着撤掉。旧快照没有这一项就不动说明。 */
  noteFor?: string[]
}

/** Agent 的下一样进哪一格:第一个没钉的格;只有一格且钉着 → 新开第二格;两格都钉 → -1。 */
export function agentSlot(items: DeskItem[]): number {
  const [a, b] = items
  if (!a || !a.pin) return 0
  if (!b || !b.pin) return 1
  return -1
}

/** 正在显示的格子下标(只看一格时只有那一格)。 */
export function visibleSlots(core: Pick<DeskCore, 'items' | 'solo'>): number[] {
  const n = Math.min(2, core.items.length)
  if (n === 2 && (core.solo === 0 || core.solo === 1)) return [core.solo]
  return Array.from({ length: n }, (_, i) => i)
}

/** 把条目记进「最近放过的」:按身份去重(新的那份顶替旧的),最新在前,≤8。 */
export function rememberRecent(recent: DeskItem[] | undefined, add: DeskItem[]): DeskItem[] {
  const out: DeskItem[] = []
  for (const it of [...add, ...(recent || [])]) {
    if (it.live || out.some((x) => sameThing(x, it))) continue
    out.push(unpinned(it))
    if (out.length >= DESK_RECENT_CAP) break
  }
  return out
}

const liveIndex = (items: DeskItem[], toolId: string): number => items.findIndex((x) => x.live?.toolId === toolId)

/** 直播格落成 / 清场时,它占的那格还原成什么:带着 bumped 且它没和别的格重复 → bumped(继承这格的钉住),否则拿掉这格。 */
function giveBack(items: DeskItem[], at: number, exclude?: DeskItem): DeskItem[] {
  const cell = items[at]
  const back = cell?.live?.bumped
  const dup = !back || (exclude && sameThing(back, exclude)) || items.some((x, j) => j !== at && (sameThing(x, back) || x.key === back.key))
  return dup ? dropAt(items, at) : setAt(items, at, pinnedAs(back, cell.pin))
}

/** Agent 编辑落盘(deskAutoShow)与插件工具卡自动进 Desk。没钉的时候 = replaceTop。 */
export function deskLand(items: DeskItem[], item: DeskItem, toolId?: string): DeskItem[] {
  const at = toolId ? liveIndex(items, toolId) : -1
  if (!hasPins(items) && at <= 0) return replaceTop(items, item)
  // 钉住的格正演着这份文件 → 原地刷新(钉住照旧);直播格把位置还回去
  const p = items.findIndex((x, j) => j !== at && x.pin && !x.live && sameThing(x, item))
  if (p >= 0) {
    // 只换 key / at(重挂读新内容),视图、引用参数、名字照留
    const out = setAt(items, p, { ...items[p], key: item.key, at: item.at })
    return at >= 0 ? giveBack(out, at, item) : out
  }
  if (at >= 0) {
    // 直播格接棒成磁盘真身(继承这格的钉住);另一格没钉且正是这份文件的旧版 → 换成 bumped 或拿掉
    const cell = items[at]
    let out = setAt(items, at, pinnedAs(item, cell.pin))
    const other = 1 - at
    const o = out[other]
    if (o && !o.pin && sameThing(o, item)) {
      const back = cell.live?.bumped
      out = back && !sameThing(back, item) && !sameThing(back, out[at]) ? setAt(out, other, back) : dropAt(out, other)
    }
    return out
  }
  const s = agentSlot(items)
  return s < 0 ? items : setAt(items, s, item)
}

/** 直播格上台 / 更新(deskLiveSync)。没钉、直播在顶格(或还没上台)时 = placeLiveItem;
 *  同一次调用已在某格 → 原地更新(bumped 带下去);否则进 Agent 那格,记下它顶掉的条目。两格都钉 → 不上台。 */
export function deskLivePlace(items: DeskItem[], item: DeskItem): DeskItem[] {
  if (!item.live) return deskLand(items, item)
  const at = liveIndex(items, item.live.toolId)
  if (!hasPins(items) && at <= 0) return placeLiveItem(items, item)
  if (at >= 0) {
    const cell = items[at]
    return setAt(items, at, pinnedAs(withBumped(item, cell.live?.bumped), cell.pin))
  }
  const s = agentSlot(items)
  if (s < 0) return items
  const cell = items[s]
  const bumped = cell ? (cell.live ? cell.live.bumped : cell) : undefined
  return setAt(items, s, withBumped(item, bumped && !bumped.live ? unpinned(bumped) : undefined))
}

/** 直播格清场(失败 / 没落成)。没钉、直播在顶格 = clearLiveTop;否则还原它那格(去重)。找不到 → null。 */
export function deskLiveClearAt(items: DeskItem[] | undefined, toolId: string): DeskItem[] | null {
  if (!items) return null
  const at = liveIndex(items, toolId)
  if (at < 0) return null
  if (at === 0 && !hasPins(items)) return clearLiveTop(items, toolId)
  return giveBack(items, at)
}

/** 点了引用 / 「正在编辑」行(deskShowFile)。没钉、也没有直播时 = 原来的顶格逻辑;
 *  否则:已经在某一格 → 原地(同一种视图只换参数,key 不变不重挂);直播格写完前不换内容 → 进另一格;
 *  再否则进 Agent 那格(两格都钉 → 上格)。引用不改变格子的钉住状态。 */
export function deskCite(items: DeskItem[], path: string, item: DeskItem, sameView: (x: DeskItem) => boolean): DeskItem[] {
  const liveAt = items.findIndex((x) => x.live)
  if (!hasPins(items) && liveAt < 0) {
    const top = items[0]
    return replaceTop(items, top && sameView(top) ? { ...top, view: item.view, at: item.at } : item)
  }
  if (liveAt >= 0 && liveKeepsDesk([items[liveAt], ...dropAt(items, liveAt)], path)) return items
  // 请进来的是直播格(两格都钉时点「正在编辑」行):记下它顶掉的那格,写失败了还回去
  const put = (x: DeskItem | undefined): DeskItem => pinnedAs(item.live && x && !x.live ? withBumped(item, unpinned(x)) : item, x?.pin)
  const h = items.findIndex((x) => !x.live && (sameView(x) || sameThing(x, item) || samePath(x.path, path)))
  if (h >= 0) {
    const x = items[h]
    return setAt(items, h, sameView(x) ? { ...x, view: item.view, at: item.at } : put(x))
  }
  const t = liveAt >= 0 ? 1 - liveAt : Math.max(0, agentSlot(items))
  return setAt(items, t, put(items[t]))
}

export type DeskAction =
  | { type: 'land'; item: DeskItem; toolId?: string }
  | { type: 'live'; item: DeskItem }
  | { type: 'liveClear'; toolId: string }
  | { type: 'present'; items: DeskItem[]; note?: string }
  | { type: 'cite'; path: string; item: DeskItem; sameView: (x: DeskItem) => boolean }
  /** 用户经 ▾ 换内容 / 把文件拖进这一格:这一格钉住;选的正在另一格 → 对调。 */
  | { type: 'pick'; slot: number; item: DeskItem }
  /** ⋯「移到上面 / 下面」:两格对调,挪动的那样钉住。 */
  | { type: 'move'; slot: number }
  | { type: 'remove'; slot: number }
  | { type: 'unpin'; slot: number }
  | { type: 'solo'; slot?: number }
  /** 打开了 ▾:那颗点算看过了。 */
  | { type: 'seen' }
  | { type: 'clear' }

// 清掉的字段写成 undefined 而不是 delete:调用方把结果铺在旧状态上({ ...cur, ...next }),删掉的键会让旧值留下来
function settle(prev: DeskCore, next: DeskCore): DeskCore {
  const out: DeskCore = { ...next }
  const items = out.items
  if (items.length < 2 || (out.solo !== 0 && out.solo !== 1) || out.solo >= items.length) out.solo = undefined
  const shown = visibleSlots(out).map((i) => items[i])
  if (out.fresh && !out.fresh.startsWith('live:') && shown.some((x) => deskIdentity(x) === out.fresh)) out.fresh = undefined
  if (out.note && out.noteFor) {
    const onDesk = items.flatMap((x) => (x.live?.bumped ? [x, x.live.bumped] : [x])).map(deskIdentity)
    if (!out.noteFor.some((id) => onDesk.includes(id) || id === out.fresh)) { out.note = undefined; out.noteFor = undefined }
  }
  if (items !== prev.items) {
    const rec = rememberRecent(out.recent, items)
    if (rec.length) out.recent = rec
  }
  return out
}

/** 被 Agent 放进了你看不见的地方(两格都钉 / 收起的那格)→ 记成 fresh;看得见就不记。 */
function noteFresh(core: DeskCore, id: string, items: DeskItem[]): string | undefined {
  const shown = visibleSlots({ items, solo: core.solo }).map((i) => items[i])
  return shown.some((x) => deskIdentity(x) === id || (id.startsWith('live:') && x.live && `live:${x.live.toolId}` === id)) ? core.fresh : id
}

/** Desk 摆法的唯一入口(纯函数)。条目没变时 items 保持同一个数组引用。 */
export function deskReduce(core: DeskCore, a: DeskAction): DeskCore {
  const items = core.items || []
  switch (a.type) {
    case 'land': {
      const next = deskLand(items, a.item, a.toolId)
      const id = deskIdentity(a.item)
      const liveFresh = a.toolId && core.fresh === `live:${a.toolId}`
      const placed = next.some((x) => sameThing(x, a.item))
      const recent = placed ? core.recent : rememberRecent(core.recent, [a.item])
      const fresh = placed ? noteFresh({ ...core, fresh: liveFresh ? undefined : core.fresh }, id, next) : id
      return settle(core, { ...core, items: next, recent, fresh })
    }
    case 'live': {
      const next = deskLivePlace(items, a.item)
      const id = `live:${a.item.live?.toolId}`
      const onDesk = next.some((x) => x.live?.toolId === a.item.live?.toolId)
      return settle(core, { ...core, items: next, fresh: onDesk ? noteFresh(core, id, next) : id })
    }
    case 'liveClear': {
      const next = deskLiveClearAt(items, a.toolId)
      const fresh = core.fresh === `live:${a.toolId}` ? undefined : core.fresh
      if (!next && fresh === core.fresh) return core
      return settle(core, { ...core, items: next ?? items, fresh })
    }
    case 'present': {
      const noteFor = a.note !== undefined ? a.items.map(deskIdentity) : core.noteFor
      const note = a.note !== undefined ? a.note : core.note
      if (!hasPins(items)) return settle(core, { ...core, items: a.items.slice(0, 2), solo: undefined, note, noteFor })
      let next = items
      let slot = agentSlot(items)
      const rest: DeskItem[] = []
      let placed: DeskItem | undefined
      let shownAlready = false
      for (const it of a.items.slice(0, 2)) {
        if (next.some((x) => x.pin && sameThing(x, it))) { shownAlready = true; continue } // 钉住的格已经在演它了
        if (slot >= 0) { next = setAt(next, slot, it); slot = -1; placed = it; continue }
        rest.push(it)
      }
      // 一样都没上格 → 第一样亮点;上了格但那格被「只看一格」收着 → 也亮点
      const fresh = placed ? noteFresh(core, deskIdentity(placed), next) : !shownAlready && rest[0] ? deskIdentity(rest[0]) : core.fresh
      return settle(core, { ...core, items: next, recent: rest.length ? rememberRecent(core.recent, rest) : core.recent, fresh, note, noteFor })
    }
    case 'cite': {
      const next = deskCite(items, a.path, a.item, a.sameView)
      // 点了引用,落到的那格被「只看一格」收着 → 恢复两格,别让你点了看不见
      const at = next.findIndex((x) => a.sameView(x) || sameThing(x, a.item) || samePath(x.path, a.path))
      const solo = (core.solo === 0 || core.solo === 1) && at >= 0 && at !== core.solo ? undefined : core.solo
      return settle(core, { ...core, items: next, solo })
    }
    case 'pick': {
      const cur = items[a.slot]
      if (cur?.live) return core // 直播那格写完前不换内容
      const o = items[1 - a.slot]
      if (cur && sameThing(cur, a.item)) return cur.pin ? core : settle(core, { ...core, items: setAt(items, a.slot, { ...cur, pin: true }) })
      if (cur && o && !o.live && (o.key === a.item.key || sameThing(o, a.item))) {
        // 选的正在另一格 → 对调:这一格钉住,换下去的那样带着它自己的钉住状态
        const next = [...items]
        next[a.slot] = { ...o, pin: true }
        next[1 - a.slot] = cur
        return settle(core, { ...core, items: next })
      }
      return settle(core, { ...core, items: setAt(items, Math.min(a.slot, items.length), { ...unpinned(a.item), pin: true }) })
    }
    case 'move': {
      const cur = items[a.slot]
      const o = items[1 - a.slot]
      if (!cur || !o) return core
      const next = [...items]
      next[1 - a.slot] = cur.live ? cur : { ...cur, pin: true }
      next[a.slot] = o
      const solo = core.solo === a.slot ? 1 - a.slot : core.solo === 1 - a.slot ? a.slot : core.solo
      return settle(core, { ...core, items: next, solo })
    }
    case 'remove': {
      if (!items[a.slot] || items[a.slot].live) return core
      return settle(core, { ...core, items: dropAt(items, a.slot), solo: undefined })
    }
    case 'unpin': {
      const cur = items[a.slot]
      if (!cur?.pin) return core
      return settle(core, { ...core, items: setAt(items, a.slot, unpinned(cur)) })
    }
    case 'solo':
      return settle(core, { ...core, solo: a.slot })
    case 'seen':
      return core.fresh ? { ...core, fresh: undefined } : core
    case 'clear':
      return { ...core, items: [], note: undefined, noteFor: undefined, solo: undefined, fresh: undefined }
  }
}

/** ▾ 菜单的内容:顶上「Agent 刚放的」(若有),下面「最近放过的」:这一格(灰)、另一格(标「在另一格」),再往下按最近。 */
export function deskMenuRows(core: DeskCore, slot: number): {
  fresh: DeskItem | { liveToolId: string } | null
  rows: Array<{ item: DeskItem; where: 'this' | 'other' | null }>
} {
  const items = core.items || []
  const cur = items[slot]
  const other = items[1 - slot]
  let fresh: DeskItem | { liveToolId: string } | null = null
  if (core.fresh?.startsWith('live:')) fresh = { liveToolId: core.fresh.slice(5) }
  else if (core.fresh) fresh = [other, ...(core.recent || [])].find((x) => x && !x.live && deskIdentity(x) === core.fresh) ?? null
  const rows: Array<{ item: DeskItem; where: 'this' | 'other' | null }> = []
  const push = (it: DeskItem | undefined, where: 'this' | 'other' | null): void => {
    if (!it || it.live || rows.length >= DESK_RECENT_CAP || rows.some((r) => sameThing(r.item, it))) return
    if (fresh && 'key' in fresh && sameThing(fresh, it) && where !== 'this') return
    rows.push({ item: it, where })
  }
  push(cur, 'this')
  push(other, 'other')
  for (const it of core.recent || []) push(it, null)
  return { fresh, rows }
}

/** 另一扇窗写了快照(storage 事件):只认**这次写入真改了**的会话(旧值与新值不同)——别的会话照旧是对面盘上的旧样子,
 *  收下会把本窗还没落盘的改动退回去。会话从快照里消失(超容量被挤出)不当删除。 */
export function deskSessionsChanged(before: Record<string, DeskSnapshot>, incoming: Record<string, DeskSnapshot>): string[] {
  return Object.keys(incoming).filter((sid) => JSON.stringify(before[sid] ?? null) !== JSON.stringify(incoming[sid]))
}

const DESK_SYNC_FIELDS = ['recent', 'fresh', 'solo', 'note', 'noteFor', 'split'] as const
/** 收下对面这条会话的摆法(条目、钉住、最近放过的、点、说明、分界、只看一格);形态与宽度(mode / fraction / size)
 *  是每扇窗自己的,不跟。条目完全相同(key、视图参数、钉住都一样)才沿用本窗的对象,否则用对面的(重挂读新内容 / 新落点)。
 *  本窗自己的直播格按 Agent 落位规则重新摆回去(直播格不落盘,对面看不见它)。没变 → 原对象。 */
export function adoptDeskArrangement<T extends DeskSnapshot>(cur: T | undefined, theirs: DeskSnapshot): T {
  const base = (cur ?? { items: [], size: theirs.size || 'half', ...(theirs.mode ? { mode: theirs.mode } : {}) }) as T
  const lives = base.items.filter((x) => x.live)
  let items = theirs.items.map((t) => base.items.find((x) => !x.live && JSON.stringify(x) === JSON.stringify(t)) ?? t)
  for (const lv of lives) items = deskLivePlace(items, { ...lv, live: { ...lv.live!, bumped: undefined } })
  const sameItems = items.length === base.items.length && items.every((x, i) => x === base.items[i])
  const sameRest = DESK_SYNC_FIELDS.every((k) => JSON.stringify(base[k] ?? null) === JSON.stringify(theirs[k] ?? null))
  if (sameItems && sameRest) return base
  const out = { ...base, items: sameItems ? base.items : items } as T
  for (const k of DESK_SYNC_FIELDS) (out as unknown as Record<string, unknown>)[k] = theirs[k]
  return out
}
