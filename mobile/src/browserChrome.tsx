/** Browser implementation of the mobile chrome seam. The shell still owns navigation, titles and actions;
 * this host draws the same surfaces in the DOM when there is no native platform. */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, ChevronDown, LayoutGrid, MoreHorizontal, PanelLeft, PanelRight, Search, UserRound, X } from 'lucide-react'
import {
  dispatchNativeChromeAction, dispatchNativeChromeSpace, installNativeChromeHost, nativeRailCells, useSpaceStore, useWideLayout,
  UI_ZOOM_EVENT, type NativeChromeAction, type NativeChromeSpace, type NativeChromeState,
} from '@lcl/engine'
import { accountChip, subscribeAccountChip } from '@/services/accountChip'
import { useApp } from '@/stores/appStore'
import { useAttention } from '@/stores/attentionStore'
import { useInbox } from '@/stores/inboxStore'
import { spaceBadges } from './nativeChrome'
import { installBrowserSheet, BrowserSheet } from './browserSheet'
import './browserChrome.css'

let state: NativeChromeState = { mode: 'hidden' }
let installed = false
let queued = false
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** True once the web host installed this chrome (mobileEntry). The shell's browser-only pieces (the DOM chrome, browser
 *  Back, the tap ripple) follow this one flag rather than "not a native platform" — see the gate in mobileEntry. */
export function browserChromeInstalled(): boolean { return installed }

export function installBrowserChrome(): void {
  if (installed) return
  installed = true
  installBrowserSheet()
  installNativeChromeHost({
    spaces: true,
    render(next) {
      state = next
      // A view may set its leaf title while rendering. Deliver the latest state after that render finishes.
      if (queued) return
      queued = true
      queueMicrotask(() => { queued = false; listeners.forEach((fn) => fn()) })
    },
  })
}

const subscribeBadges = (fn: () => void): (() => void) => {
  const offs = [useApp.subscribe(fn), useAttention.subscribe(fn), useInbox.subscribe(fn)]
  return () => { offs.forEach((off) => off()) }
}
const badgeSnapshot = (): string => JSON.stringify(spaceBadges())

/** The two capsules' widths (px of the viewport = the board's px) for what lays itself out in their row: the board's top
 *  islands on a wide layout (base.css ⑦, read through `[data-nc-caps]`). The same rule Android's host writes
 *  (mobile/src/nativeChrome.ts `capsuleWidths`): one stylesheet rule, not a property on <body> that restyles the page. */
function writeCapsuleWidths(left: number, right: number): void {
  const css = `[data-nc-caps]{--nc-capl-w:${Math.max(0, Math.round(left))};--nc-capr-w:${Math.max(0, Math.round(right))}}`
  let el = document.getElementById('nc-caps')
  if (!el) { el = document.createElement('style'); el.id = 'nc-caps'; document.head.appendChild(el) }
  if (el.textContent !== css) el.textContent = css
}

function Action({ action, label, children }: { action: NativeChromeAction; label: string; children: React.ReactNode }) {
  return <button className="bmc-button" data-chrome-action={action} aria-label={label} onClick={() => dispatchNativeChromeAction(action)}>{children}</button>
}

/** One Space cell of the dock / the rail: icon over name (the same cell Android draws in both). */
function Destination({ sp, badge }: { sp: NativeChromeSpace; badge?: string }) {
  const Icon = useSpaceStore((s) => s.spaces.find((x) => x.id === sp.id)?.icon)
  return <button className="bmc-destination" data-space={sp.id} aria-current={sp.active ? 'page' : undefined} onClick={() => dispatchNativeChromeSpace(sp.id)}>
    <span className="bmc-destination-icon">{Icon && <Icon size={22} />}{badge && <i className="bmc-badge" data-kind={badge} aria-label={useApp.getState().tr(`nativebar.badge.${badge}`)} />}</span>
    <span>{sp.label}</span>
  </button>
}

/** The rail's cell box (px) and the gap between cells: = RAIL_CELL_HEIGHT / RAIL_CELL_GAP (Android NativeChromeBar.kt). */
const RAIL_CELL_HEIGHT = 58
const RAIL_CELL_GAP = 4

export function BrowserChrome() {
  const chrome = useSyncExternalStore(subscribe, () => state)
  const account = useSyncExternalStore(subscribeAccountChip, accountChip)
  const badges = JSON.parse(useSyncExternalStore(subscribeBadges, badgeSnapshot)) as ReturnType<typeof spaceBadges>
  const topRef = useRef<HTMLElement>(null)
  const dockRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const railCellsRef = useRef<HTMLDivElement>(null)
  const destinations = chrome.mode === 'shell' ? chrome.spaces ?? [] : []
  const dock = destinations.filter((sp) => sp.pinned)
  const spaceBar = destinations.length > 1
  // Wide layout (Pad A2, same line as the shell's docked column): the Spaces stand in a rail at the left edge instead of the
  // dock, the avatar at its foot, and the whole shell starts after it (browserChrome.css). Portrait stays the phone layout.
  const wide = useWideLayout()
  const showRail = wide && spaceBar
  const showDock = !wide && spaceBar
  const showAll = destinations.some((sp) => !sp.pinned)
  const atDetail = chrome.mode === 'shell' && chrome.leftBack
  // As many cells as the rail's height holds (measured), past that the pinned ones first and a last cell for "all".
  const [railFit, setRailFit] = useState(Number.MAX_SAFE_INTEGER)
  const rail = nativeRailCells(destinations, railFit)
  // Wide layout (Pad A2): the shell reports the docked left column's right edge (`leftInset`, viewport px) — the capsules
  // start after it, so the column's own header is not under the title capsule (singleColumn.css aligns that header with
  // the capsule row). `capLeftMax`: the view lays something out in this row right of the title (the board) → cut the title.
  const leftInset = chrome.mode === 'shell' ? chrome.leftInset ?? 0 : 0
  const capLeftMax = chrome.mode === 'shell' ? chrome.capLeftMax ?? 0 : 0

  // Reuse the shell's existing inset contract. Measure actual CSS zoom and safe areas, including browser
  // orientation / toolbar / keyboard changes. Only write when the value changes, to avoid page-wide restyles.
  useLayoutEffect(() => {
    const measure = (): void => {
      const top = chrome.mode !== 'hidden' ? topRef.current?.getBoundingClientRect().bottom ?? 0 : 0
      const bottom = showDock ? window.innerHeight - (dockRef.current?.getBoundingClientRect().top ?? window.innerHeight) : 0
      for (const [key, value] of [['--nc-top', top], ['--nc-bottom', bottom]] as const) {
        const next = String(Math.max(0, Math.round(value)))
        if (document.body.style.getPropertyValue(key) !== next) document.body.style.setProperty(key, next)
      }
      writeCapsuleWidths(headingRef.current?.getBoundingClientRect().width ?? 0, actionsRef.current?.getBoundingClientRect().width ?? 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (topRef.current) observer.observe(topRef.current)
    if (dockRef.current) observer.observe(dockRef.current)
    if (headingRef.current) observer.observe(headingRef.current)
    if (actionsRef.current) observer.observe(actionsRef.current)
    window.addEventListener('resize', measure)
    window.addEventListener(UI_ZOOM_EVENT, measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener(UI_ZOOM_EVENT, measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [chrome.mode, showDock, atDetail, leftInset, showRail])
  useLayoutEffect(() => {
    // The shell starts after the rail (browserChrome.css): one attribute, flipped on rotation only.
    document.documentElement.toggleAttribute('data-browser-rail', showRail)
    const el = railCellsRef.current
    if (!showRail || !el) return
    const fit = (): void => setRailFit(Math.max(0, Math.floor((el.clientHeight + RAIL_CELL_GAP) / (RAIL_CELL_HEIGHT + RAIL_CELL_GAP))))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [showRail])
  useLayoutEffect(() => () => {
    document.body.style.removeProperty('--nc-top')
    document.body.style.removeProperty('--nc-bottom')
    document.getElementById('nc-caps')?.remove()
    document.documentElement.removeAttribute('data-browser-rail')
  }, [])

  // leftInset (from the shell's left edge) / capLeftMax are viewport px; the chrome sits under the body's UI zoom.
  // With the rail the capsules start after it and then after the docked column, as on Android (rail + leftInset).
  const railLeft = showRail ? 'var(--bmc-rail-w) + env(safe-area-inset-left) / var(--uiz, 1)' : ''
  const topStyle = leftInset || showRail ? { left: `calc(${[railLeft, leftInset ? `${leftInset}px / var(--uiz, 1)` : ''].filter(Boolean).join(' + ')})` } : undefined
  const headingStyle = capLeftMax ? { maxWidth: `min(65%, calc(${capLeftMax}px / var(--uiz, 1)))` } : undefined
  return <>
    {chrome.mode !== 'hidden' && <div className="bmc-chrome" data-browser-mobile-chrome data-mode={chrome.mode}>
      <header className="bmc-top" ref={topRef} style={topStyle}>
        <div className="bmc-capsule bmc-heading" ref={headingRef} style={headingStyle}>
          {chrome.mode === 'page'
            ? <Action action="back" label={chrome.back}><ArrowLeft size={20} /></Action>
            : chrome.left && <Action action="left" label={chrome.labels.left}>{chrome.leftBack ? <ArrowLeft size={20} /> : <PanelLeft size={20} />}</Action>}
          {chrome.mode === 'shell' && chrome.titleTap
            ? <button className="bmc-title" data-chrome-action="title" onClick={() => dispatchNativeChromeAction('title')}><span>{chrome.title}</span>{chrome.titleSub && <small>{chrome.titleSub}</small>}<ChevronDown size={14} /></button>
            : <div className="bmc-title"><span>{chrome.title}</span>{chrome.mode === 'shell' && chrome.titleSub && <small>{chrome.titleSub}</small>}</div>}
        </div>
        <div className="bmc-capsule bmc-actions" ref={actionsRef}>
          {chrome.mode === 'page'
            ? chrome.close && <Action action="close" label={chrome.close}><X size={20} /></Action>
            : <>
              {chrome.search && <Action action="search" label={chrome.search}><Search size={20} /></Action>}
              {chrome.right && <Action action="right" label={chrome.labels.right}><PanelRight size={20} /></Action>}
              {chrome.tabCount > 1 && <Action action="tabs" label={chrome.labels.tabs}><span className="mb-tabcount">{chrome.tabCount}</span></Action>}
              <Action action="more" label={chrome.labels.more}><MoreHorizontal size={20} /></Action>
              {!atDetail && !showRail && account && <button className="bmc-button bmc-account" aria-label={account.label} data-chrome-action="account" onClick={() => account.activate()}>
                {account.avatar ? <img src={account.avatar} alt="" /> : account.loggedIn ? account.initial : <UserRound size={20} />}
              </button>}
            </>}
        </div>
      </header>
      {showDock && chrome.mode === 'shell' && <nav ref={dockRef} className="bmc-dock" aria-label={chrome.allLabel}>
        {dock.map((sp) => <Destination key={sp.id} sp={sp} badge={badges[sp.id]} />)}
        {showAll && <button className="bmc-destination" data-chrome-action="spacesAll" onClick={() => dispatchNativeChromeAction('spacesAll')}><LayoutGrid size={22} /><span>{chrome.allLabel}</span></button>}
      </nav>}
      {showRail && chrome.mode === 'shell' && <nav className="bmc-rail" aria-label={chrome.allLabel}>
        <div className="bmc-rail-cells" ref={railCellsRef}>
          {rail.cells.map((sp) => <Destination key={sp.id} sp={sp} badge={badges[sp.id]} />)}
          {rail.more.length > 0 && <button className="bmc-destination" data-chrome-action="spacesAll" aria-current={rail.more.some((sp) => sp.active) ? 'page' : undefined} onClick={() => dispatchNativeChromeAction('spacesAll')}><LayoutGrid size={22} /><span>{chrome.allLabel}</span></button>}
        </div>
        {account && <button className="bmc-button bmc-account" aria-label={account.label} data-chrome-action="account" onClick={() => account.activate()}>
          {account.avatar ? <img src={account.avatar} alt="" /> : account.loggedIn ? account.initial : <UserRound size={20} />}
        </button>}
      </nav>}
    </div>}
    <BrowserSheet />
  </>
}
