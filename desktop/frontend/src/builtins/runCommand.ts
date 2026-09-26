/**
 * 代码块「运行」→ 内置终端(底部面板)→ 退出后把结果回传给会话。
 *
 * ⚠️ 命令绝不进持久化的 view params:布局恢复时终端 tab 一挂载就 spawn,Desk 快照也落盘 ——
 * `cmd` 若在 params 里,重启 app = 无人点击又把 `find … -delete` 跑一遍。所以 params 只带一次性
 * token,命令住内存 Map;恢复时 token 找不到就退化成普通登录 shell。
 *
 * ponytail: 不做输出流式回传、不做多命令队列;一次 Run = 一个终端 tab = 一条结果消息。
 */
import { getView, useWorkspace } from '@lcl/engine'
import { registerMessages, translate } from '../i18n'

registerMessages({
  'terminal.runTitle': { zh: '在内置终端运行', en: 'Run in the built-in terminal' },
  'terminal.runResult': { zh: '在终端执行了命令（退出码 {code}）：', en: 'Ran the command in the terminal (exit code {code}):' },
  'terminal.runOutput': { zh: '输出（末尾 {n} 行）：', en: 'Output (last {n} lines):' },
  'terminal.runOutputAll': { zh: '输出：', en: 'Output:' },
  'terminal.runNoOutput': { zh: '（无输出）', en: '(no output)' },
})

export interface RunResult { cmd: string; cwd?: string; code: number; output: string }
export interface PendingRun { cmd: string; cwd?: string; onExit?: (r: RunResult) => void }

const pending = new Map<string, PendingRun>()
let seq = 0

/** 只有这几种 fence 算「可运行的 shell」;`console`(带 $ 提示符 + 输出混排)刻意不算。 */
export function isShellLang(lang: string | undefined | null): boolean {
  return /^(bash|sh|zsh|shell)$/i.test(lang ?? '')
}

/** 模型常写 `$ npm install` 这种带提示符的行:只剥行首的 `$ `,`$?`/`$HOME` 不受影响。 */
export function stripPrompt(code: string): string {
  return code.replace(/^\$ +/gm, '').trim()
}

export function registerPendingRun(run: PendingRun): string {
  const token = `run${++seq}-${Date.now().toString(36)}`
  pending.set(token, run)
  return token
}

/** 一次性:取走即删。布局恢复带着旧 token 再挂载 → undefined → 普通 shell。 */
export function takePendingRun(token: unknown): PendingRun | undefined {
  if (typeof token !== 'string') return undefined
  const run = pending.get(token)
  pending.delete(token)
  return run
}

export const RESULT_TAIL_LINES = 80

/** 回传给 agent 的用户消息正文(跟随界面语言):命令 / 退出码 / 输出尾部。 */
export function runResultText(r: RunResult, tail = RESULT_TAIL_LINES): string {
  const lines = r.output.replace(/\s+$/, '').split('\n')
  const cut = lines.length > tail
  const body = (cut ? lines.slice(-tail) : lines).join('\n').trim()
  const head = translate('terminal.runResult', { code: String(r.code) })
  const outHead = body ? (cut ? translate('terminal.runOutput', { n: String(tail) }) : translate('terminal.runOutputAll')) : translate('terminal.runNoOutput')
  const cwd = r.cwd ? `\n(cwd: ${r.cwd})` : ''
  return `${head}${cwd}\n\`\`\`bash\n${r.cmd}\n\`\`\`\n${outHead}${body ? `\n\`\`\`\n${body}\n\`\`\`` : ''}`
}

/** 在底部面板开一个新终端 tab 跑命令。没有 PTY(web/移动端)返回 false,调用方自己决定藏按钮。 */
export function runInTerminal(cmd: string, opts: { cwd?: string; onExit?: (r: RunResult) => void } = {}): boolean {
  if (!window.tangu?.pty || !getView('terminal')) return false
  const token = registerPendingRun({ cmd, cwd: opts.cwd, onExit: opts.onExit })
  const leaf = useWorkspace.getState().openView('terminal', { runToken: token, ...(opts.cwd ? { cwd: opts.cwd } : {}) }, 'bottom', { newTab: true })
  if (!leaf) { takePendingRun(token); return false }
  return true
}
