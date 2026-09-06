/**
 * 渲染端诊断环形缓冲 —— 只进「导出会话日志 / 反馈附件」(services/sessionLog.ts),不上屏、不落盘。
 *
 * 三端共用:本模块由 appStore 静态引入,ES 模块依赖先于入口正文求值,所以 desktop / web / mobile
 * 都在首个 React 渲染之前装好监听,且不必动 main.tsx / mobileEntry.tsx(它们各自的 init catch 另调
 * recordError('init'),因为被 try/catch 吞掉的启动错误不会派发 window 'error')。
 * 依赖铁律同 activity/log.ts:零依赖、永不抛。重载即散 —— 它记的是这一次进程里发生过什么。
 */
const CAP = 200

export interface DiagError { t: number; kind: string; msg: string }
export interface UiActionRecord {
  t: number
  runId: string
  ackId: string
  kind: string
  key?: string
  value?: string
  id?: string
  /** run_ui_command 的参数,JSON 截到 200 字符(可能含笔记路径,够定位就行)。 */
  args?: string
  /** 被哪道闸拦掉(no-ackId / not-owner / duplicate / stopped / exception);为空 = 执行了。 */
  drop?: string
  ok?: boolean
  error?: string
  state?: string
  /** 回执 HTTP 结果(状态码或 'network');sendUiAck 本身永不抛,这里是它唯一的可观测口。 */
  ack?: string
}

export const rendererErrors: DiagError[] = []
export const uiActionLog: UiActionRecord[] = []

function push<T>(buf: T[], item: T): void {
  buf.push(item)
  if (buf.length > CAP) buf.shift()
}

/** 记一条渲染端错误。栈只留前 4 帧:够定位,不把整条 /Users/<name>/… 满盘托出。 */
export function recordError(kind: string, err: unknown): void {
  try {
    const e = err as { stack?: string; message?: string } | null
    const msg = String(e?.stack || e?.message || err).split('\n').slice(0, 4).join('\n').slice(0, 600)
    push(rendererErrors, { t: Date.now(), kind, msg })
  } catch { /* never throw */ }
}

const cut = (s: string | undefined): string | undefined => (s === undefined ? undefined : String(s).slice(0, 200))

/** 每个字符串字段都截到 200:value 是模型给的、state/error 是插件/渲染端给的,都没有上界。 */
export function recordUiAction(entry: Omit<UiActionRecord, 't' | 'args'> & { args?: unknown }): void {
  try {
    const { args: rawArgs, ...rest } = entry
    const args = rawArgs === undefined ? undefined : JSON.stringify(rawArgs).slice(0, 200)
    push(uiActionLog, {
      ...rest,
      key: cut(rest.key), value: cut(rest.value), id: cut(rest.id), state: cut(rest.state), error: cut(rest.error),
      ...(args !== undefined ? { args } : {}),
      t: Date.now(),
    })
  } catch { /* never throw */ }
}

if (typeof window !== 'undefined') {
  try {
    window.addEventListener('error', (e) => recordError('window', e.error || e.message))
    window.addEventListener('unhandledrejection', (e) => recordError('rejection', e.reason))
  } catch { /* ignore */ }
}
