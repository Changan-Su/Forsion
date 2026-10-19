// 现场圈注(2026-10-19,使用指南「带我去」方案 B,方案页 docs/ToBeImproved/使用指南可视化指引方案_2026-10-19/):
// 在真界面上圈住 `[data-guide-anchor="<名字>"]` 那一处,旁边一张 `.ui-popover` 小卡说这一步做什么。
// 不压暗整屏、不拦点击(圈本身 pointer-events: none),同一时刻只有一处;由 ctx.app.spotlight 驱动,只给首方包。
//
// 锚点名单只在 GUIDE_ANCHORS 一处;组件里写同名的 data-guide-anchor。改名 / 删组件时这里和 check:guide-anchors 一起改。
import { useWorkspace } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'
import './guideSpotlight.css'

registerMessages({
  'guideSpot.ok': { zh: '知道了', en: 'Got it' },
  'guideSpot.mute': { zh: '不再提示', en: "Don't show again" },
})

/** 锚点名 → 它住在哪一栏(侧栏收着时先替用户展开那一栏)。 */
export const GUIDE_ANCHORS: Record<string, { side?: 'left' | 'right' }> = {
  'ribbon-spaces': {}, // Ribbon 上区的 Space 图标组(lcl/engine/Ribbon.tsx)
  'chat-composer': {}, // 对话输入卡(views/chat2/Composer2.tsx)
  'note-new': { side: 'left' }, // 笔记左栏「新建笔记」(amadeusViews.tsx)
  'note-body': {}, // 笔记正文(amadeus/unified/UnifiedPage.tsx;文档模式才有)
  'note-canvas': {}, // 「文档 / 画布」胶囊里的「画布」(amadeus/unified/CanvasModeSeg.tsx)
  'agent-new': { side: 'left' }, // Agents 左栏底部「创建 Agent」(views/AgentProfileView.tsx)
}

export type SpotlightResult = 'ok' | 'mute' | 'gone' | 'missing' | 'replaced' | 'closed'
export interface SpotlightOptions { anchor: string; title: string; body?: string; step?: string }

const WAIT_MS = 2000 // 切 Space 后目标要等布局建好;超过这么久还没有 → missing,插件退回老做法
const GONE_MS = 300 // 目标短暂消失(重渲)不算走了
const BAND = 44 // 目标又宽又高(正文区)时只圈顶上一条 —— 「在这里打字」指的是第一行

interface Active { owner: string; finish: (r: SpotlightResult) => void }
let active: Active | null = null

const findAnchor = (name: string): HTMLElement | null => {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide-anchor="${CSS.escape(name)}"]`)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

/** 关掉当前圈注;owner 给了就只关它自己的(插件停用时宿主按插件 id 收)。 */
export function closeSpotlight(owner?: string, result: SpotlightResult = 'closed'): void {
  if (active && (!owner || active.owner === owner)) active.finish(result)
}

export function showSpotlight(owner: string, opts: SpotlightOptions): Promise<SpotlightResult> {
  closeSpotlight(undefined, 'replaced')
  const name = String(opts?.anchor ?? '')
  if (!(name in GUIDE_ANCHORS)) return Promise.resolve('missing')
  return new Promise((resolve) => {
    let raf = 0, done = false, ring: HTMLElement | null = null, card: HTMLElement | null = null, lostAt = 0
    const finish = (r: SpotlightResult): void => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      ring?.remove(); card?.remove()
      window.removeEventListener('keydown', onKey, true)
      if (active?.finish === finish) active = null
      resolve(r)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && card) { e.stopPropagation(); finish('ok') } }
    active = { owner, finish }

    const mount = (): void => {
      ring = document.createElement('div')
      ring.className = 'guide-spot-ring'
      card = document.createElement('div')
      card.className = 'ui-popover guide-spot-card'
      card.setAttribute('role', 'dialog')
      const line = (cls: string, text?: string): void => { if (!text) return; const d = document.createElement('div'); d.className = cls; d.textContent = text; card!.appendChild(d) }
      line('guide-spot-step', opts.step); line('guide-spot-title', opts.title); line('guide-spot-body', opts.body)
      const act = document.createElement('div'); act.className = 'guide-spot-act'
      const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'guide-spot-mute'; mute.textContent = translate('guideSpot.mute'); mute.onclick = () => finish('mute')
      const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn sm'; ok.textContent = translate('guideSpot.ok'); ok.onclick = () => finish('ok')
      act.append(mute, ok); card.appendChild(act)
      document.body.append(ring, card)
      window.addEventListener('keydown', onKey, true)
    }

    // ponytail: 圈注活着时每帧量一次目标(布局、滚动、窗口缩放都跟得上);同一时刻只有一处,开销可忽略。
    const place = (el: HTMLElement): void => {
      const z = (document.body as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1 // body 上有界面缩放
      const r = el.getBoundingClientRect()
      const vw = innerWidth / z, vh = innerHeight / z
      let x = r.left / z, y = r.top / z, w = r.width / z, h = r.height / z
      if (w > 300 && h > 120) h = BAND
      const pad = 4
      Object.assign(ring!.style, { left: `${x - pad}px`, top: `${y - pad}px`, width: `${w + pad * 2}px`, height: `${h + pad * 2}px` })
      const cw = card!.offsetWidth, ch = card!.offsetHeight, gap = 12
      let side: 'below' | 'above' | 'right'
      let cx: number, cy: number
      if (h > w * 2 && x + w + gap + cw < vw) { side = 'right'; cx = x + w + pad + gap; cy = Math.min(Math.max(8, y), vh - ch - 8) } // 竖条(Ribbon):卡放右边
      else if (y + h + pad + gap + ch < vh) { side = 'below'; cx = x; cy = y + h + pad + gap }
      else { side = 'above'; cx = x; cy = y - pad - gap - ch }
      cx = Math.min(Math.max(8, cx), vw - cw - 8)
      card!.dataset.side = side
      card!.style.setProperty('--guide-spot-arrow', side === 'right' ? `${Math.min(Math.max(14, y + Math.min(h, 40) / 2 - cy), ch - 14)}px` : `${Math.min(Math.max(14, x + Math.min(w, 60) / 2 - cx), cw - 14)}px`)
      Object.assign(card!.style, { left: `${cx}px`, top: `${cy}px` })
    }

    const started = performance.now()
    let opened = false
    const tick = (): void => {
      if (done) return
      const el = findAnchor(name)
      if (!ring) {
        if (el) { mount(); place(el) } else {
          const t = performance.now() - started
          const side = GUIDE_ANCHORS[name]!.side
          if (!opened && side && t > 400) { // 目标在收着的侧栏里:展开一次再等
            opened = true
            const ws = useWorkspace.getState()
            if (!(side === 'left' ? ws.leftVisible : ws.rightVisible)) ws.toggleSidebar(side)
          }
          if (t > WAIT_MS) { finish('missing'); return }
        }
      } else if (el) { lostAt = 0; place(el) } else {
        lostAt ||= performance.now()
        if (performance.now() - lostAt > GONE_MS) { finish('gone'); return }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  })
}
