/**
 * 任务概览的确定性投影:会话消息账本 → 事实视图模型。
 * 只归并已有事件(审批/询问/todo/展示文件/工具调用),不额外调模型生成摘要,
 * 也绝不回流进 agent 上下文 —— 依据《Forsion-Codex Claude 右侧卡片原型》§17.4 / §17.5。
 * 渲染在 TaskSummary.tsx。
 */
import type { DisplayFile, TodoItem, ToolEvent, UiMessage } from '../../types'

/** 一条「用过的来源」:agent 实际读到/搜到/取到的东西。用户给的附件不算(§7.4 两者不能混)。 */
export interface TaskSource {
  kind: 'file' | 'dir' | 'web' | 'search'
  /** 归并身份:文件/目录=路径,网页=URL,搜索=查询串。 */
  id: string
  /** 显示名:文件/目录=末段名,网页=域名(§7.4),搜索=查询串。 */
  label: string
  /** 命中次数 —— 同一来源访问多次只占一行,次数放这(§17.3)。 */
  hits: number
}

/** 哪些工具产出「来源」。写/改/执行类不算来源,它们是动作。 */
const SOURCE_KIND: Record<string, TaskSource['kind']> = {
  read_file: 'file', read_document: 'file', read_log: 'file', view_image: 'file',
  list_dir: 'dir', list_files: 'dir',
  search_files: 'search', glob_files: 'search', web_search: 'search',
  web_fetch: 'web',
}

/**
 * 哪些工具产出「产物」(写盘)。
 * ponytail: 只认参数里带路径的写工具。run_python / run_bash / pip_install 造出来的文件,
 * 参数里根本没有路径(是一段脚本),投影不出来 —— 要覆盖它们只能由引擎在工具前后对 cwd 做
 * 文件系统快照 diff,那是引擎侧的活,不是这层能补的。
 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit'])
/** apply_patch 的目标路径藏在 patch 正文里。Delete 不算产物(文件已经没了)。 */
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update) File: (.+)$/gm

const ABS_RE = /^([/~]|[A-Za-z]:[\\/])/
const lastSeg = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() || p
const hostOf = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
/** 相对路径拼 cwd,统一成和 display_file 同一种形态,否则同一个文件会占两行。 */
const absolutize = (p: string, cwd?: string): string =>
  !cwd || ABS_RE.test(p) ? p : cwd.replace(/[/\\]+$/, '') + '/' + p

/** 已完成且未失败的调用才算数(§17.3):否则「尝试访问过」会被读成「已采信的资料」。 */
const counts = (ev: ToolEvent): boolean => !!ev.done && !ev.isError

function argsOf(ev: ToolEvent): any {
  try { return ev.arguments ? JSON.parse(ev.arguments) : {} } catch { return null }
}

function sourceOf(ev: ToolEvent, cwd?: string): TaskSource | null {
  if (!counts(ev)) return null
  const kind = SOURCE_KIND[ev.name] || (ev.name.startsWith('browser_') ? 'web' : null)
  if (!kind) return null
  const a = argsOf(ev)
  if (!a) return null
  const raw = kind === 'web' ? a.url : kind === 'search' ? (a.query ?? a.pattern ?? a.glob) : a.path
  let id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) return null
  if (kind === 'file' || kind === 'dir') id = absolutize(id, cwd)
  return { kind, id, label: kind === 'web' ? hostOf(id) : kind === 'search' ? id : lastSeg(id), hits: 1 }
}

/** 一次工具调用写出的文件路径(可能多个:apply_patch 一次改几份)。 */
function writesOf(ev: ToolEvent, cwd?: string): string[] {
  if (!counts(ev)) return []
  const a = argsOf(ev)
  if (!a) return []
  if (WRITE_TOOLS.has(ev.name)) {
    const p = typeof a.path === 'string' ? a.path.trim() : ''
    return p ? [absolutize(p, cwd)] : []
  }
  if (ev.name !== 'apply_patch') return []
  const patch = typeof a.patch === 'string' ? a.patch : typeof a.input === 'string' ? a.input : ''
  return [...patch.matchAll(PATCH_PATH_RE)].map((m) => absolutize(m[1].trim(), cwd)).filter(Boolean)
}

export interface TaskFacts {
  /** 顶部主状态。等待用户永远压过「正在运行」(§17.10 验收:等待审批时不得显示为 Running)。
   *  stopped 单列一档:用户中途摁停不是成功完成,不许显示「已完成」。 */
  state: 'attention' | 'running' | 'error' | 'stopped' | 'done' | 'idle'
  /** 待处理的审批/询问。 */
  attention: { kind: 'approval' | 'inquiry'; text: string }[]
  /** 最新一版任务清单(todo 事件整单替换,故后来者覆盖)。 */
  todos: TodoItem[]
  /** 当前动作 = 最后一个未结束的工具调用;由渲染层转成「动词 + 对象」。跑完即无。 */
  action: ToolEvent | null
  /** 来源:agent 读过的文件/目录、搜过的查询、取过的网页,按身份归并。 */
  sources: TaskSource[]
  /** 产物:agent 展示的文件(display_file/生图)+ 写盘工具改过的文件,按 path‖name 归并
   *  (§17.3 身份优先于显示文本)。脚本(run_python/run_bash)造的文件覆盖不到,见 WRITE_TOOLS。 */
  outputs: DisplayFile[]
  /** 本轮起点(最后一条用户消息),用于「已运行」。 */
  startedAt: number | null
  /** 最近一条助手消息的错误;它成功了就清空(最新状态覆盖)。null=没失败,''=失败但没给原因。 */
  error: string | null
}

/** cwd:把工具参数里的相对路径拼成绝对路径,好跟 display_file 的形态归并成一行。
 *  只该在 host 会话传 —— 沙箱会话的路径本来就是工作区相对路径,拼上本机 cwd 反而错。 */
export function summarizeTask(messages: UiMessage[], running: boolean, cwd?: string): TaskFacts {
  const attention: TaskFacts['attention'] = []
  const sources = new Map<string, TaskSource>()
  const outputs = new Map<string, DisplayFile>()
  let todos: TodoItem[] = []
  let action: ToolEvent | null = null
  let startedAt: number | null = null
  let error: string | null = null
  let stopped = false

  for (const m of messages) {
    // 新一轮开始:上一轮摁停留下的「未结束」工具不属于这一轮,必须清掉,
    // 否则新 run 刚起步(还没发工具)时会把上一轮那个残留动作重新显示成「正在做」。
    if (m.role === 'user') { startedAt = m.timestamp; action = null }
    for (const a of m.approvals || []) if (a.status === 'pending') attention.push({ kind: 'approval', text: a.name })
    for (const q of m.inquiries || []) if (q.status === 'pending') attention.push({ kind: 'inquiry', text: q.question })
    // 判存在而非判长度:`todo_write([])` 是合法的「清空清单」,用 ?.length 会把它当没发生、继续显示旧计划。
    if (m.todos) todos = m.todos
    for (const f of m.displayFiles || []) outputs.set(f.path || f.name, f)
    for (const ev of m.toolEvents || []) {
      if (!ev.done) action = ev
      // 写盘产物:display_file 那条(带 mime/dataUrl)更权威,已经登记过就不覆盖。
      for (const p of writesOf(ev, cwd)) if (!outputs.has(p)) outputs.set(p, { name: lastSeg(p), path: p })
      const src = sourceOf(ev, cwd)
      if (!src) continue
      const cur = sources.get(`${src.kind}:${src.id}`)
      if (cur) cur.hits++
      else sources.set(`${src.kind}:${src.id}`, src)
    }
    if (m.role === 'assistant') {
      error = m.status === 'error' ? (m.error || '') : null
      stopped = m.status === 'stopped'
    }
  }

  return {
    // error 判存在而非判真值:失败但没带原因时 error='',用 `error ?` 会把它误判成成功。
    state: attention.length ? 'attention'
      : running ? 'running'
      : error !== null ? 'error'
      : stopped ? 'stopped'
      : messages.length ? 'done' : 'idle',
    attention,
    todos,
    // 停止/失败后残留的未结束工具不是「正在做」,不许继续显示成当前动作。
    action: running ? action : null,
    sources: [...sources.values()],
    outputs: [...outputs.values()],
    startedAt,
    error,
  }
}

/** 有对话就出现(§17.2:宽屏默认固定显示;「有事实才出现」是分区级规则,不是整块面板级)。
 *  空会话(idle=一条消息都没有)不出——那会儿没有任何状态可报。 */
export const hasFacts = (f: TaskFacts): boolean => f.state !== 'idle'
