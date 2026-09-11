/**
 * 消息末尾的两种围栏 —— 助手在回复里写:
 *   ```forsion-suggest  一行一条「用户原话」建议 → 渲染成一排可点芯片(点了=用户把这句话发出去);
 *   ```forsion-task     一张自包含任务卡(title/tldr/track 头部 + `---` + prompt 任务书)→ 渲染成卡片,
 *                        落点三档:在此执行 / 新会话执行 / 交给 Muse 追踪(2026-09-10,对标 Claude Code 的 spawn_task)。
 *   ```forsion-approval 一条待审批引用(`{"id":"…"}`,引擎在 ask 档排队时写进收件箱消息,2026-09-11)→ 渲染成审批卡;
 *                        卡上的工具/预览/理由按 id 从 pending_approvals 读,**正文里的字一个不信**(见 InboxBody)。
 * 这里把它们从正文摘出来 —— 正文照常走 Markdown,芯片/卡片单独渲染(见 EditorialMessage / InboxBody)。
 * 调用方用 `kinds` 声明自己认哪几种(缺省 suggest+task):收件箱传 task+approval —— 没有会话,不认 suggest(芯片没处发);
 * 聊天不认 approval(没有渲染它的卡)。不认的围栏原样留在正文当代码块;**超过上限的合法卡也还回正文**,绝不静默吞掉。
 *
 * 为什么是围栏不是工具:建议/任务卡本身**什么也不做**(点了才发消息 / 建日程),
 * 为一个纯展示的东西给每轮请求加一条 tool schema 不划算。写法教在内置技能 automation-suggest 里。
 *
 * ⚠️必须按 CommonMark 的围栏规则走,不能逐行独立匹配:模型讲解这个功能本身时会写
 * ````markdown ```forsion-suggest … ``` ```` 或 ~~~markdown … ~~~,逐行匹配会把教学示例变成真芯片/真卡片
 * (卡片能发消息、建日程,误判就是把示例文本升格成用户指令)。
 * 故:① 只认「不在任何围栏里」时开的 forsion-suggest / forsion-task 栏;② 反引号与波浪线两种围栏都要认,
 * 收口必须**同一种字符**且反引号数 ≥ 开栏数;③ 缩进 ≤3 空格(4 空格是缩进代码块)。
 */

/** 开/收栏行:≤3 空格缩进 + ≥3 个同种字符(` 或 ~)+ info 串。反引号围栏的 info 里不能有反引号(CommonMark)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*\r?$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/
/** 任务卡头部 `key: value` 行(键只认字母/数字/-/_;未知键忽略 = 扩展契约)。 */
const HEADER = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/
const DIVIDER = /^\s*---\s*$/

/** 一条建议的长度窗:太短(「继续」「好的」)不是自成一句的请求,太长就不像「能直接发出去的一句话」。 */
const MIN_LEN = 4
const MAX_LEN = 80
const MAX_ITEMS = 3
/** 任务卡:每条消息最多 2 张;标题/摘要/任务书各自封顶(任务书是新会话的第一条消息,给足空间)。 */
const MAX_TASKS = 2
const TITLE_MAX = 120
const TLDR_MAX = 200
export const PROMPT_MAX = 8000

export type FenceKind = 'suggest' | 'task' | 'approval'
/** 缺省(聊天)不认 approval:聊天链只渲染芯片与任务卡,认了就等于把围栏悄悄吃掉(Codex 09-11 P1);收件箱显式开。 */
const DEFAULT_KINDS: FenceKind[] = ['suggest', 'task']
/** 审批 id 只认引擎生成的形态(uuid / 短 id);别的一律当写坏还回正文。 */
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_APPROVALS = 2

/** 任务卡:title 必填;prompt = 自包含任务书(新会话不共享上下文,路径/症状/文件都得写死在里面);
 *  track=true 表示「不必马上做 / 要持续跟进」→ 卡片主按钮变「交给 Muse 追踪」。 */
export interface TaskCard {
  title: string
  tldr?: string
  track?: boolean
  /** Muse TODO 的行 id(引擎在 add_muse_todo 的收件箱投影里写 `todo: <id>`):落点回写这条 TODO,「交给 Muse」= 批准它去做(见 taskLanding)。
   *  只有调用方显式开 `todo` 才解析(收件箱里 Muse 自己的信);别处的 `todo:` 按未知键忽略 —— 别的 agent 不能冒充 Muse 的待办。 */
  todo?: string
  prompt: string
}

/** 跨段续读用的围栏状态(段之间可能插着工具块,一道围栏会被切断)。 */
export interface SuggestState {
  /** 当前打开的围栏字符数;0 = 不在围栏里。 */
  fence: number
  /** 围栏字符(` 或 ~);收口必须同种。 */
  fenceChar: '`' | '~' | ''
  /** 这道围栏是 forsion-suggest / forsion-task,还是普通代码块(null)。 */
  kind: FenceKind | null
  /** 未收口的建议/任务围栏原文(含开栏行)——收口才认;没收口要么丢弃要么还回正文。 */
  pending: string[]
}

export interface Suggestions {
  /** 摘掉围栏之后的正文 —— 渲染、复制、朗读都用它,别让用户看见/听见围栏原文。 */
  text: string
  items: string[]
  tasks: TaskCard[]
  /** 待审批行 id(forsion-approval 围栏;去重)。 */
  approvals: string[]
  /** 喂给下一段的续读状态(每次调用返回新对象,不改调用方传入的那份)。 */
  state: SuggestState
}

const FRESH = (): SuggestState => ({ fence: 0, fenceChar: '', kind: null, pending: [] })

/** 围栏正文(不含开栏行)→ 任务卡;缺 title/prompt → null(整块还回正文由调用方决定:这里只认合法卡)。 */
export function parseTaskCard(lines: string[], opts?: { todo?: boolean }): TaskCard | null {
  const idx = lines.findIndex((l) => DIVIDER.test(l))
  let header: string[]
  let body: string[]
  if (idx >= 0) {
    header = lines.slice(0, idx)
    body = lines.slice(idx + 1)
  } else {
    // 没有 --- 分隔:只有首行是已知键(title/tldr/track)时才把开头连续的 key: value 行当头部,
    // 其余整段是任务书 —— 英文任务书里 "Note: …" 这类行不能被误吃成头部。
    const known = (l: string): boolean => /^\s*(title|tldr|track)\s*:/i.test(l)
    let n = 0
    if (lines.length && known(lines[0])) while (n < lines.length && HEADER.test(lines[n])) n++
    header = lines.slice(0, n)
    body = lines.slice(n)
  }
  let title = ''
  let tldr = ''
  let track = false
  let todo = ''
  for (const h of header) {
    const m = HEADER.exec(h)
    if (!m) continue
    const k = m[1].toLowerCase()
    if (k === 'title') title = m[2]
    else if (k === 'tldr') tldr = m[2]
    else if (k === 'track') track = /^(true|yes|1)$/i.test(m[2])
    else if (k === 'todo') todo = m[2]
    // 未知键忽略:将来加字段不破旧客户端
  }
  const prompt = body.join('\n').trim().slice(0, PROMPT_MAX)
  if (!title) title = (body.find((l) => l.trim()) || '').trim()
  title = title.trim().slice(0, TITLE_MAX)
  if (!title || !prompt) return null
  // todo id 与审批 id 同一形态约束;不合法只丢这个键(卡照出,只是不回写 TODO)。
  return { title, ...(tldr ? { tldr: tldr.slice(0, TLDR_MAX) } : {}), ...(track ? { track: true } : {}), ...(opts?.todo && APPROVAL_ID_RE.test(todo) ? { todo } : {}), prompt }
}

/** 围栏正文 → 审批行 id:认 `{"id":"…"}` JSON、`id: …` 行、或单独一行裸 id;别的 → null(整块还回正文)。 */
export function parseApprovalId(lines: string[]): string | null {
  const text = lines.join('\n').trim()
  if (!text) return null
  let id = ''
  if (text.startsWith('{')) {
    try { const o = JSON.parse(text); id = typeof o?.id === 'string' ? o.id : '' } catch { return null }
  } else {
    const m = /^\s*id\s*:\s*(\S+)\s*$/i.exec(text)
    id = m ? m[1] : text
  }
  return APPROVAL_ID_RE.test(id) ? id : null
}

/**
 * @param kinds 认哪几种围栏(缺省全部);不认的围栏按普通代码块留在正文。
 * @param todo 任务卡的 `todo:` 头是否生效(缺省否;只有收件箱里 Muse 自己的信才开,见 InboxBody)。
 * @param streaming 后面还可能有文本(还在流式打字,或这只是消息里靠前的一段)→ 没收口的围栏先藏起来
 *                  (否则用户会先看见一段裸代码块再看它消失);整条消息**已完成且这是最后一段**却没收口 =
 *                  模型写坏了,把内容**还回正文**,绝不吞用户看得见的字。
 */
export function splitSuggestions(
  raw: string,
  opts?: { streaming?: boolean; state?: SuggestState; kinds?: FenceKind[]; todo?: boolean },
): Suggestions {
  const kinds = opts?.kinds ?? DEFAULT_KINDS
  // 续读状态深拷贝 pending:调用方常把上一段的 state 存起来复用,这里就地 push 会污染它。
  const st: SuggestState = opts?.state ? { ...opts.state, pending: [...opts.state.pending] } : FRESH()
  if (!st.fence && !raw.includes('forsion-suggest') && !raw.includes('forsion-task') && !raw.includes('forsion-approval')) return { text: raw, items: [], tasks: [], approvals: [], state: st } // 绝大多数消息走这条快路
  const body: string[] = []
  const items: string[] = []
  const tasks: TaskCard[] = []
  const approvals: string[] = []

  const take = (line: string): void => {
    const s = line.replace(BULLET, '').trim()
    if (s.length >= MIN_LEN && s.length <= MAX_LEN && items.length < MAX_ITEMS) items.push(s)
  }
  /** 收口:芯片按行收;任务卡解析,写坏的卡连同真实的收口行原样还回正文(不吞字、不改写围栏)。 */
  const close = (closingLine: string): void => {
    if (st.kind === 'suggest') for (const l of st.pending.slice(1)) take(l)
    else if (st.kind === 'task') {
      const card = parseTaskCard(st.pending.slice(1), { todo: opts?.todo })
      if (card && tasks.length < MAX_TASKS) tasks.push(card)
      else body.push(...st.pending, closingLine) // 写坏的、或超过上限的:原样还回正文(Codex 09-11 P2:第三张不能凭空消失)
    } else if (st.kind === 'approval') {
      const id = parseApprovalId(st.pending.slice(1))
      if (id && approvals.includes(id)) { /* 同 id 重复:只渲染一张卡,围栏也不必还回 */ }
      else if (id && approvals.length < MAX_APPROVALS) approvals.push(id)
      else body.push(...st.pending, closingLine)
    }
    st.pending = []
  }

  for (const line of raw.split('\n')) {
    const m = FENCE.exec(line)
    if (!st.fence) {
      // 反引号围栏的 info 不许含反引号;波浪线围栏无此限制(CommonMark)。
      if (m && (m[1][0] === '~' || !m[2].includes('`'))) {
        st.fence = m[1].length
        st.fenceChar = m[1][0] as '`' | '~'
        const kind: FenceKind | null = m[2] === 'forsion-suggest' ? 'suggest' : m[2] === 'forsion-task' ? 'task' : m[2] === 'forsion-approval' ? 'approval' : null
        st.kind = kind && kinds.includes(kind) ? kind : null
        if (st.kind) { st.pending = [line]; continue }
      }
      body.push(line)
      continue
    }
    // 围栏里:只有「同种字符 + 数量 ≥ 开栏数 + info 为空」才收口。异种/更短的只是内容。
    if (m && m[1][0] === st.fenceChar && m[1].length >= st.fence && !m[2]) {
      if (st.kind) close(line)
      else body.push(line)
      st.fence = 0
      st.fenceChar = ''
      st.kind = null
      continue
    }
    if (st.kind) st.pending.push(line)
    else body.push(line)
  }

  if (st.fence && st.kind && !opts?.streaming) {
    body.push(...st.pending) // 已完成却没收口 → 还回正文
    st.pending = []
    st.fence = 0
    st.fenceChar = ''
    st.kind = null
  }
  // 只削掉围栏留下的空行,不动行内缩进(4 空格缩进代码块的语义靠它)。
  return { text: body.join('\n').replace(/^\n+|\s+$/g, ''), items, tasks, approvals, state: st }
}
