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
  'note-canvas': {}, // 「文档 / 画布」胶囊里的「画布」(amadeus/unified/CanvasModeSeg.tsx 的 canvasModesSpec,经 lcl ViewModeSwitch 挂上)
  'agent-new': { side: 'left' }, // Agents 左栏底部「创建 Agent」(views/AgentProfileView.tsx)
}

export type SpotlightResult = 'ok' | 'mute' | 'gone' | 'missing' | 'replaced' | 'closed'
export interface SpotlightOptions { anchor: string; title: string; body?: string; step?: string }

const WAIT_MS = 2000 // 切 Space 后目标要等布局建好;超过这么久还没有 → missing,插件退回老做法
const GONE_MS = 300 // 目标短暂消失(重渲)不算走了
const BAND = 44 // 目标又宽又高(正文区)时只圈顶上一条 —— 「在这里打字」指的是第一行

interface Active { owner: string; finish: (r: SpotlightResult) => void }
let active: Active | null = null

/** 锚点在插件 View 里(`data-guide-owner` = 插件 id)。`host:` 开头的 owner 是宿主自己的界面(主页 = `host:home`),
 *  不算插件的 —— 插件 id 里不会有冒号(manifest id 只许小写字母、数字、连字符)。宿主的圈注和宿主提示都只跳过插件 View。 */
export const inPluginView = (el: Element): boolean => !!el.closest('[data-guide-owner]:not([data-guide-owner^="host:"])')

const findAnchor = (name: string): HTMLElement | null => {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide-anchor="${CSS.escape(name)}"]`)) {
    if (inPluginView(el)) continue // 插件 View 里同名的锚点不算宿主的(插件抢不走首方圈注);主页这类 host: owner 里的照样算
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
  const name = String(opts?.anchor ?? '')
  if (!(name in GUIDE_ANCHORS)) return Promise.resolve('missing')
  return present({ owner, find: () => findAnchor(name), side: GUIDE_ANCHORS[name]!.side, style: 'ring', title: opts.title, body: opts.body, step: opts.step, dock: false })
}

/** 插件的上手提示(guideTips.ts 驱动,2026-11-02):目标元素由调用方找(只在那个插件自己的 View 里找),不查 GUIDE_ANCHORS。
 *  `ring` 同上面的圈注;`line` 不画圈,只在目标上沿贴一行(同宽,× / Esc = 知道了)。`dock`(手机)时圈注的小卡贴到底部
 *  输入区 / Dock 上方成一条,不浮在小目标旁边。和 showSpotlight 共用同一个槽:同一时刻全应用只有一处。 */
export function showTip(owner: string, opts: { find: () => HTMLElement | null; style: 'ring' | 'line'; title?: string; body: string; dock: boolean; extra?: TipExtra }): Promise<SpotlightResult> {
  return present({ owner, ...opts })
}

/** 当前有没有圈注 / 提示在出(上手提示的调度看它:有就不出新的)。 */
export const spotlightActive = (): boolean => active != null

/** 宿主提示的额外动作(如通话提示的「换个音色」):占「不再提示」的位置;点了先收提示(记看过)再执行。 */
export interface TipExtra { label: string; run: () => void }
interface Present { owner: string; find: () => HTMLElement | null; side?: 'left' | 'right'; style: 'ring' | 'line'; title?: string; body?: string; step?: string; dock: boolean; extra?: TipExtra }

function present(o: Present): Promise<SpotlightResult> {
  closeSpotlight(undefined, 'replaced')
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
    active = { owner: o.owner, finish }
    const line = o.style === 'line'
    const mount = (): void => {
      if (!line) { ring = document.createElement('div'); ring.className = 'guide-spot-ring' }
      card = document.createElement('div')
      card.className = line ? 'guide-tip-line' : 'ui-popover guide-spot-card'
      card.setAttribute('role', line ? 'status' : 'dialog')
      const add = (cls: string, text?: string): void => { if (!text) return; const d = document.createElement('div'); d.className = cls; d.textContent = text; card!.appendChild(d) }
      if (line) {
        add('guide-tip-text', o.body)
        const x = document.createElement('button'); x.type = 'button'; x.className = 'guide-tip-x'; x.setAttribute('aria-label', translate('guideSpot.ok'))
        x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
        x.onclick = () => finish('ok')
        card.appendChild(x)
      } else {
        add('guide-spot-step', o.step); add('guide-spot-title', o.title); add('guide-spot-body', o.body)
        const act = document.createElement('div'); act.className = 'guide-spot-act'
        const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'guide-spot-mute'
        const extra = o.extra
        if (extra) { mute.textContent = extra.label; mute.onclick = () => { finish('ok'); try { extra.run() } catch (e) { console.error('[guide] tip action failed', e) } } }
        else { mute.textContent = translate('guideSpot.mute'); mute.onclick = () => finish('mute') }
        const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn sm'; ok.textContent = translate('guideSpot.ok'); ok.onclick = () => finish('ok')
        act.append(mute, ok); card.appendChild(act)
      }
      if (ring) document.body.append(ring)
      document.body.append(card)
      window.addEventListener('keydown', onKey, true)
    }
    // ponytail: 圈注活着时每帧量一次目标(布局、滚动、窗口缩放都跟得上);同一时刻只有一处,开销可忽略。
    const place = (el: HTMLElement): void => {
      const z = (document.body as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1 // body 上有界面缩放
      const r = el.getBoundingClientRect()
      const vw = innerWidth / z, vh = innerHeight / z
      let x = r.left / z, y = r.top / z, w = r.width / z, h = r.height / z
      if (line) { // 贴目标上沿,同宽;上面放不下就贴下沿
        Object.assign(card!.style, { left: `${x}px`, width: `${w}px` }) // 先定宽再量高(折行看宽度)
        const ch = card!.offsetHeight, gap = 6
        card!.style.top = `${y - gap - ch >= 8 ? y - gap - ch : Math.min(y + h + gap, vh - ch - 8)}px`
        return
      }
      if (w > 300 && h > 120) h = BAND
      const pad = 4
      Object.assign(ring!.style, { left: `${x - pad}px`, top: `${y - pad}px`, width: `${w + pad * 2}px`, height: `${h + pad * 2}px` })
      if (o.dock) { card!.dataset.side = 'dock'; return } // 位置全在 CSS(贴底部那一条)
      const cw = card!.offsetWidth, ch = card!.offsetHeight, gap = 12
      let side: 'below' | 'above' | 'right'
      let cx: number, cy: number
      if (h > w * 2 && x + w + gap + cw < vw) { side = 'right'; cx = x + w + pad + gap; cy = Math.min(Math.max(8, y), vh - ch - 8) } // 竖条(Ribbon):卡放右边
      else if (y + h + pad + gap + ch < vh) { side = 'below'; cx = x; cy = y + h + pad + gap }
      else { side = 'above'; cx = x; cy = y - pad - gap - ch }
      cx = Math.min(Math.max(8, cx), vw - cw - 8)
      cy = Math.min(Math.max(8, cy), vh - ch - 8)
      card!.dataset.side = side
      card!.style.setProperty('--guide-spot-arrow', side === 'right' ? `${Math.min(Math.max(14, y + Math.min(h, 40) / 2 - cy), ch - 14)}px` : `${Math.min(Math.max(14, x + Math.min(w, 60) / 2 - cx), cw - 14)}px`)
      Object.assign(card!.style, { left: `${cx}px`, top: `${cy}px` })
    }

    const started = performance.now()
    let opened = false
    const tick = (): void => {
      if (done) return
      const el = o.find()
      if (!card) {
        if (el) { el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); mount(); place(el) } else { // 侧栏滚过头时目标在视口外(Codex 评审)
          const t = performance.now() - started
          if (!opened && o.side && t > 400) { // 目标在收着的侧栏里:展开一次再等
            opened = true
            const ws = useWorkspace.getState()
            if (!(o.side === 'left' ? ws.leftVisible : ws.rightVisible)) ws.toggleSidebar(o.side)
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
