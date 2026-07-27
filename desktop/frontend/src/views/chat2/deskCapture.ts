/** Agent Desk 截屏:引擎的 desk_screenshot 工具经 SSE(desk_capture_request)要一张图,
 *  这里找到面板 DOM → 交主进程 capturePage 抓真实像素 → POST 回引擎兑现。
 *  截**渲染结果**而不是 DOM 复刻:Desk 里跑的是原生视图/webview/canvas,复刻方案一律抓成空白。 */
import { sendDeskCapture } from '../../services/agentRunService'
import type { TanguDesktopConfig } from '../../types'

export interface DeskShotOut {
  dataUrl?: string
  mode?: 'card' | 'open'
  error?: string
}

/** 展开动画 0.32s + 卡片进出(chat2.css)——不等就抓到中间态(量 rail 几何的老坑同源)。 */
const SETTLE_MS = 400

/** 该截哪块:优先展开的侧板,否则卡片态的小预览;都按 sessionId 认领(多窗口/多聊天面板)。 */
export function findDeskTarget(sessionId: string, doc: Document = document): { el: HTMLElement; mode: 'card' | 'open' } | null {
  const pick = (hostSel: string, bodySel: string, mode: 'card' | 'open'): { el: HTMLElement; mode: 'card' | 'open' } | null => {
    for (const host of Array.from(doc.querySelectorAll<HTMLElement>(hostSel))) {
      if (host.dataset.deskSession !== sessionId) continue
      const body = host.querySelector<HTMLElement>(bodySel)
      if (body) return { el: body, mode }
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
  if (!target) return { error: 'the Agent Desk panel is not on screen (turned off, hidden, or the window is too narrow)' }
  const rect = deskRect(target.el, window.innerWidth, window.innerHeight)
  if (!rect) return { error: 'the Agent Desk panel is too small / scrolled out of view' }
  const dataUrl = await capture(rect)
  return dataUrl ? { dataUrl, mode: target.mode } : { error: 'the screenshot failed' }
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
