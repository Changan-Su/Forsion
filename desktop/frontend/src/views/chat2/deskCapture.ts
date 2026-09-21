/** Agent Desk 截屏:引擎的 desk_screenshot 工具经 SSE(desk_capture_request)要一张图,
 *  这里找到面板 DOM → 交主进程 capturePage 抓真实像素 → POST 回引擎兑现。
 *  截**渲染结果**而不是 DOM 复刻:Desk 里跑的是原生视图/webview/canvas,复刻方案一律抓成空白。 */
import { sendDeskCapture } from '../../services/agentRunService'
import type { TanguDesktopConfig } from '../../types'

export interface DeskShotOut {
  dataUrl?: string
  mode?: 'card' | 'open'
  /** 截到的是插件伴随面(它的 key,如 `plugin:live3d:avatar`):引擎据此告诉模型「这是插件画的形象,不是你放上来的」。 */
  companion?: string
  error?: string
}

/** 展开动画 0.32s + 卡片进出(chat2.css)——不等就抓到中间态(量 rail 几何的老坑同源)。 */
const SETTLE_MS = 400
/** 本窗口没有这个会话的 Desk 时晚一点再报错:引擎只认**第一个**到达的回图(多窗口里每个订阅了这条 run 的窗口
 *  都会答),没 Desk 的窗口抢先回「不在屏幕上」会把真正截得到的那份挤成 410。截图本身远小于这个余量。 */
const NOT_HERE_GRACE_MS = 1500

export interface DeskTarget {
  el: HTMLElement
  mode: 'card' | 'open'
  /** 这块正在演的插件伴随面 key(always 模式 / idle 模式零条目),没有 = null:截到的是形象,不是 agent 放上来的
   *  东西。判 DOM 而不判 deskReplacedByCompanion():就是 capturePage 要抓的那块元素,一处判定盖住两种模式。 */
  companion: string | null
}

/** 该截哪块:优先展开的侧板,否则卡片态的小预览;都按 sessionId 认领(多窗口/多聊天面板)。 */
export function findDeskTarget(sessionId: string, doc: Document = document): DeskTarget | null {
  const pick = (hostSel: string, bodySel: string, mode: 'card' | 'open'): DeskTarget | null => {
    for (const host of Array.from(doc.querySelectorAll<HTMLElement>(hostSel))) {
      if (host.dataset.deskSession !== sessionId) continue
      const body = host.querySelector<HTMLElement>(bodySel)
      if (!body) continue
      const slot = body.querySelector<HTMLElement>('.agent-desk-companion')
      return { el: body, mode, companion: slot ? slot.querySelector<HTMLElement>('[data-companion]')?.dataset.companion || 'plugin' : null }
    }
    return null
  }
  return pick('.agent-desk.open', '.agent-desk-body', 'open')
    // .gone = 隐身常驻(卡片不可关的实现),截它只会得到一块空白
    || pick('.agent-desk-card:not(.gone)', '.agent-desk-card-body', 'card')
}

/** 视口矩形(capturePage 的坐标系)。getBoundingClientRect 已是视口坐标、body 端级 zoom 已计入
 *  ——别拿 offsetWidth/computed px 去"反补偿"(那些是未缩放局部 px,是另一个坑的解法)。 */
export function deskRect(
  el: { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } },
  vw: number,
  vh: number,
): { x: number; y: number; width: number; height: number } | null {
  const r = el.getBoundingClientRect()
  const x = Math.max(0, Math.floor(r.left))
  const y = Math.max(0, Math.floor(r.top))
  const width = Math.floor(Math.min(r.right, vw) - x)
  const height = Math.floor(Math.min(r.bottom, vh) - y)
  return width >= 16 && height >= 16 ? { x, y, width, height } : null
}

export async function captureDesk(sessionId: string): Promise<DeskShotOut> {
  const capture = window.tangu?.captureRect
  if (!capture) return { error: 'screenshots need the Forsion desktop app' }
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  const target = findDeskTarget(sessionId)
  if (!target) {
    await new Promise((r) => setTimeout(r, NOT_HERE_GRACE_MS))
    return { error: 'the Agent Desk panel is not on screen (turned off, hidden, or the window is too narrow)' }
  }
  const rect = deskRect(target.el, window.innerWidth, window.innerHeight)
  if (!rect) return { error: 'the Agent Desk panel is too small / scrolled out of view' }
  const dataUrl = await capture(rect)
  // 伴随面照截(09-19 用户:agent 得能看见 Desk 上渲染出来的形象),但带上 companion —— 引擎据此说明这是插件画的,
  // 免得模型把形象当成自己放上来的产物(上午那版直接回错误,结果 agent 什么都看不见)。
  if (!dataUrl) return { error: 'the screenshot failed' }
  return target.companion ? { dataUrl, mode: target.mode, companion: target.companion } : { dataUrl, mode: target.mode }
}

/** SSE 入口:截图并兑现。失败也必须 POST——否则引擎那头只能干等到超时。 */
export async function answerDeskCapture(cfg: TanguDesktopConfig, runId: string, sessionId: string, shotId: string): Promise<void> {
  let out: DeskShotOut
  try {
    out = await captureDesk(sessionId)
  } catch (e: any) {
    out = { error: String(e?.message || e) }
  }
  await sendDeskCapture(cfg, runId, shotId, out)
}
