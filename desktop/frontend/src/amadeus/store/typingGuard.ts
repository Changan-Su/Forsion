/**
 * 打字静默闸 —— 远端/外部回灌不许打断正在敲的那一下。
 *
 * 背景(2026-08-08 用户实报「多设备云同步在线编辑会卡输入法、还吞掉最新输入的内容」):
 * `pageStore.reconcileExternal` 走 `hydrate()` 整页换内容,而 MarkdownBlock 在**渲染期**判
 * 「content 变了 → 换 key 重挂编辑器」。于是另一台设备一存盘,SSE 推过来,本机正在打字的那个
 * ProseMirror 实例当场被销毁:
 *  - 输入法候选框跟着宿主一起没了(= 「输入法被自动关掉」);
 *  - Milkdown 的 markdownUpdated 有 200ms 防抖,刚上屏、还没进 store 的那截字直接随实例蒸发
 *    (= 「最新输入的内容没了」)。
 * 这不是云端独有,凡是外部回灌(agent 直接写盘、Obsidian 改文件)都同一条链,所以闸设在共享层。
 *
 * 判据两条:① 正在输入法组合中;② 距上一次本地编辑不足 QUIET_MS(盖住那 200ms 防抖)。
 * ponytail: 轮询式等待而不是事件订阅 —— 等待方只有 reconcileExternal 一个,120ms 一跳足够,
 * 不值当为它铺一套 waiter 注册表。
 */

/** 静默窗口:Milkdown 200ms 防抖 + 一点余量,连打时不会被回灌插队。 */
const QUIET_MS = 700
/** 轮询间隔。 */
const POLL_MS = 120
/** 连打的等待封顶 —— 两台设备互相打字时别把回灌饿死(组合态不受此约束,见下)。 */
const MAX_WAIT_MS = 8000
/** compositionend 可能随宿主卸载一起丢失;超过这个时长就不再认组合态,免得回灌永久停摆。 */
const COMPOSE_MAX_MS = 30_000

let composeAt = 0 // >0 = 组合中
let lastEditAt = 0

const now = (): number => Date.now()

/** 本地编辑发生了(pageStore.setBlockContent 每次调用都喂一口)。 */
export function noteLocalEdit(): void {
  lastEditAt = now()
}

export function isComposing(): boolean {
  return composeAt > 0 && now() - composeAt < COMPOSE_MAX_MS
}

export function isRecentEdit(): boolean {
  return now() - lastEditAt < QUIET_MS
}

/** 装在 document 上(捕获相位,覆盖所有编辑器与输入框)。可重复调用:只装一次。 */
let installed = false
export function installTypingGuard(target: {
  addEventListener(type: string, handler: () => void, capture?: boolean): void
}): void {
  if (installed) return
  installed = true
  target.addEventListener('compositionstart', () => { composeAt = now() }, true)
  const end = (): void => {
    composeAt = 0
    // 组合刚结束 = 文字才提交给 ProseMirror,防抖还没把它送进 store —— 这一段最脆,按本地编辑算。
    lastEditAt = now()
  }
  target.addEventListener('compositionend', end, true)
  // 非输入法的连打:beforeinput 比 store 早 200ms,靠它把静默窗口对齐到真实击键。
  target.addEventListener('beforeinput', () => { lastEditAt = now() }, true)
}

/** 等到「没人在打字」再回来。组合态一律等到底(强关输入法正是这条 bug 本身),连打受 MAX_WAIT_MS 封顶。 */
export async function awaitTypingQuiet(maxWaitMs = MAX_WAIT_MS): Promise<void> {
  const deadline = now() + maxWaitMs
  while (isComposing() || (isRecentEdit() && now() < deadline)) {
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/** 仅测试用:清干净全局态。 */
export function __resetTypingGuard(): void {
  composeAt = 0
  lastEditAt = 0
  installed = false
}
