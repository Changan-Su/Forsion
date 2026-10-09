import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { ArrowLeft, MoreHorizontal, PanelLeft, PanelRight, UserRound, X } from 'lucide-react'
import {
  dispatchNativeChromeAction, dispatchNativeChromeSpace, installNativeChromeHost, readNativeTheme, renderNativeIcons, useSpaceStore,
  type NativeChromeAction, type NativeChromeSpace, type NativeChromeState, type NativeHaptic, type NativeIcon, type NativeSheetTheme,
} from '@lcl/engine'
import { registerMessages, translate } from '@/i18n'
import { accountChip, subscribeAccountChip } from '@/services/accountChip'
import { useApp } from '@/stores/appStore'
import { attentionIndex, mergeAttention, useAttention } from '@/stores/attentionStore'
import { useInbox } from '@/stores/inboxStore'

/** Android-only host for the native top bar seam (lcl/engine/nativeChrome.ts). Kotlin: NativeChromePlugin.
 *  Pushes the effective state + live theme + serialized icons; relays bar actions back to the seam.
 *  Also draws the Space switcher as a bottom navigation bar (`spaces: true`): the shell sends the Space list,
 *  this host adds each Space's icon (serialized once per icon component) and relays taps / long-presses.
 *  A Space whose icon is a picture (a plugin Space's `iconFile`) gets it as a small PNG beside its line icon.
 *  On the same first-level pages it adds the account avatar (trailing end of the top bar): what to show and
 *  what a tap does come from the mounted account card (services/accountChip.ts); the engine seam is not involved.
 *  And a badge per Space (a dot on its icon): which Spaces have something going on comes from the app's stores, here.
 *  Shell pages ask for the chrome to float over them (`floating`, 2026-10-09): two capsules at the top and a dock at
 *  the bottom, the page running under both. Kotlin then reports where everything is (`layout`); `applyChromeLayout`
 *  turns that into the room the shell keeps clear (`--nc-*` on <body>, see lcl/engine/singleColumn.css) and into the
 *  frosted plates behind the capsules — the blur is the page's to draw: a native view cannot blur the WebView.
 *  If the plugin ever rejects, the host uninstalls itself so the shell falls back to its web top bar. */
interface ChromeIcons { left?: NativeIcon; right?: NativeIcon; more?: NativeIcon; back?: NativeIcon; close?: NativeIcon }
/** `png` = the picture as base64, cropped square and downscaled here (Kotlin only decodes and clips it to a circle);
 *  `icon` = what the bar draws without one: the initial, or a person glyph when signed out. */
interface ChromeAccount { label: string; icon?: NativeIcon; png?: string }
/** The session list's three dots (sidebar2.css `.t2s-dot`), one per Space cell. `label` is for screen readers. */
type SpaceBadgeKind = 'running' | 'attention' | 'unread'
interface ChromeBadge { kind: SpaceBadgeKind; label: string }
/** Where the native chrome lies over the page, in dp (see NativeChromePlugin.reportLayout). All zero / empty unless floating. */
export interface ChromeLayout {
  floating: boolean
  /** How much of the page's top / bottom edge is under the chrome; `status` = the status-bar part of `top`. */
  top: number; bottom: number; status: number
  /** Each capsule's rectangle, relative to the page. */
  plates: Array<{ id: string; x: number; y: number; w: number; h: number }>
}
interface NativeChromePlugin {
  setState(state: Omit<NativeChromeState, 'spaces'> & {
    theme: NativeSheetTheme; icons: ChromeIcons; spaces?: Array<NativeChromeSpace & { icon?: NativeIcon; png?: string; badge?: ChromeBadge }>
    account?: ChromeAccount
    /** Shell pages only: float the chrome over the page; `frosted` = the page blurs behind the capsules. */
    floating?: boolean; frosted?: boolean
  }): Promise<void>
  haptic(options: { kind: NativeHaptic }): Promise<void>
  clear(): Promise<void>
  addListener(event: 'action', cb: (e: { action: string; id?: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'layout', cb: (e: ChromeLayout) => void): Promise<PluginListenerHandle>
}
const ACTIONS: readonly NativeChromeAction[] = ['left', 'right', 'tabs', 'more', 'back', 'close']
const MAX_SPACES = 64 // = ChromeState.MAX_SPACES (Kotlin)
const AVATAR_PX = 96 // the bar draws it at 30dp: enough for a 3x screen, a few KB on the bridge
const MAX_AVATAR_CHARS = 131_072 // = ChromeState.MAX_AVATAR_CHARS (Kotlin); an oversized picture would reject the whole state
const SPACE_ICON_PX = 72 // the bar draws a Space's picture at 24dp: 3x
// Kotlin refuses a state past 512 000 characters and the page would lose the whole native bar: pictures stay well
// inside it. One past its own cap, or past the total, is simply not sent (that Space keeps its line icon).
// ponytail: every state carries all the pictures (a 72px PNG is a few KB); cache them natively by Space id if a bar
// with dozens of plugin Spaces ever makes the pushes slow.
const MAX_SPACE_PNG_CHARS = 24_000
const MAX_SPACE_PNGS_CHARS = 240_000

registerMessages({
  'nativebar.badge.running': { zh: '有会话在运行', en: 'A session is running' },
  'nativebar.badge.attention': { zh: '有会话等你处理', en: 'A session is waiting for you' },
  'nativebar.badge.unread': { zh: '有未读', en: 'Unread' },
})
const BADGE_LABEL: Record<SpaceBadgeKind, () => string> = {
  running: () => translate('nativebar.badge.running'),
  attention: () => translate('nativebar.badge.attention'),
  unread: () => translate('nativebar.badge.unread'),
}

/** Which Spaces carry a dot right now. Tangu rolls up what its session list shows per row — waiting for the user
 *  (approvals / questions, this device and "my computer") beats running beats unread, one dot per cell; Inbox = unread
 *  mail. Unread only counts sessions that are still listed: the persisted set can outlive a deleted session.
 *  ponytail: keyed by the two built-in Space ids; give SpaceDefinition a badge seam when a plugin Space needs one. */
export function spaceBadges(): Record<string, SpaceBadgeKind> {
  const app = useApp.getState()
  const out: Record<string, SpaceBadgeKind> = {}
  const waiting = mergeAttention(attentionIndex(useAttention.getState().byTarget), app.messagesBySession, app.runningBySession).size > 0
  if (waiting) out.tangu = 'attention'
  else if (Object.keys(app.runningBySession).length) out.tangu = 'running'
  else if (app.unread.size && app.sessions.some((x) => app.unread.has(x.id))) out.tangu = 'unread'
  if (useInbox.getState().unreadCount > 0) out.inbox = 'unread'
  return out
}

/** Picture → square PNG (base64) of `px` a side. null = cannot be read (broken image, or a remote one without CORS headers taints the canvas). */
function squarePng(src: string, px: number, maxChars: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onerror = () => resolve(null)
    img.onload = () => {
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = px
        canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px)
        const png = canvas.toDataURL('image/png').split(',')[1] ?? ''
        resolve(png && png.length <= maxChars ? png : null)
      } catch { resolve(null) }
    }
    img.src = src
  })
}

/** The page can blur what is behind an element, and the user has not switched glass off (`data-glass`, DESIGN §1). */
export function pageFrosts(): boolean {
  try {
    if (document.documentElement.dataset.glass === 'off') return false
    return CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
  } catch { return false }
}

const dpNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10_000 ? v : 0)
/** dp → a length inside the page: the shell's px are scaled by the app's zoom (`--uiz`), the screen's dp are not. */
const dpLength = (v: number): string => `calc(${v}px / var(--uiz, 1))`

/** Applies a `layout` report: the room the shell keeps clear, and one plate per capsule (blur + shadow; the capsule's
 *  fill, hairline and content are native). Plates sit above everything the page draws — so does the native chrome —
 *  and take no touches. Anything unusable in the report counts as "not floating": the page then reads as before. */
export function applyChromeLayout(e: ChromeLayout | null | undefined, doc: Document = document): void {
  const body = doc.body
  if (!body) return
  const floating = !!e && e.floating === true
  const vars: Array<[string, number]> = [['--nc-top', floating ? dpNumber(e?.top) : 0], ['--nc-bottom', floating ? dpNumber(e?.bottom) : 0], ['--nc-status', floating ? dpNumber(e?.status) : 0]]
  for (const [name, value] of vars) { if (value) body.style.setProperty(name, String(value)); else body.style.removeProperty(name) }
  const plates = (floating && Array.isArray(e?.plates) ? e.plates : [])
    .filter((p) => p && /^[A-Za-z]{1,24}$/.test(String(p.id)) && dpNumber(p.w) > 0 && dpNumber(p.h) > 0)
  let box = doc.getElementById('nc-plates')
  if (!plates.length) { box?.remove(); return }
  if (!box) {
    box = doc.createElement('div')
    box.id = 'nc-plates'
    box.className = 'nc-plates'
    box.setAttribute('aria-hidden', 'true')
    body.appendChild(box)
  }
  const wanted = new Set(plates.map((p) => p.id))
  for (const el of Array.from(box.children) as HTMLElement[]) if (!wanted.has(el.dataset.plate ?? '')) el.remove()
  for (const p of plates) {
    let el = (Array.from(box.children) as HTMLElement[]).find((x) => x.dataset.plate === p.id)
    if (!el) { el = doc.createElement('div'); el.className = 'nc-plate'; el.dataset.plate = p.id; box.appendChild(el) }
    const x = typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : 0
    const y = typeof p.y === 'number' && Number.isFinite(p.y) ? p.y : 0
    el.style.cssText = `left:${dpLength(x)};top:${dpLength(y)};width:${dpLength(p.w)};height:${dpLength(p.h)}`
  }
}

let installed = false
export function installNativeChrome(): void {
  if (installed || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeChrome')) return
  installed = true
  const plugin = registerPlugin<NativeChromePlugin>('NativeChrome')
  const icons: Promise<ChromeIcons> = renderNativeIcons([PanelLeft, PanelRight, MoreHorizontal, ArrowLeft, X])
    .then(([left, right, more, back, close]) => ({ left, right, more, back, close }))
  // Space icons are React components: serialize each once (keyed by the component, so a re-registered Space re-renders).
  const spaceIcons = new Map<unknown, NativeIcon | undefined>()
  // A picture icon (a plugin Space's own `iconFile`) cannot be flattened into paths. It is sent as a small PNG, converted
  // once per source; like the avatar it never holds up a bar update: the bar goes out with the Space's line icon first
  // (SpaceIcon.nativeFallback) and once more when the PNG is ready. An SVG picture keeps the line icon.
  const spacePngs = new Map<string, string | null>()
  const spacePng = (url: string | undefined): string | null => {
    if (!url?.startsWith('data:image/png')) return null
    if (!spacePngs.has(url)) {
      spacePngs.set(url, null)
      // `has`: the source may have left the bar (plugin updated / removed) while its picture was converting
      void squarePng(url, SPACE_ICON_PX, MAX_SPACE_PNG_CHARS).then((png) => { if (png && spacePngs.has(url)) { spacePngs.set(url, png); send() } })
    }
    return spacePngs.get(url) ?? null
  }
  const withIcons = async (all: NativeChromeSpace[]): Promise<Array<NativeChromeSpace & { icon?: NativeIcon; png?: string }>> => {
    // ponytail: the bar scrolls, but a payload is still capped (Kotlin MAX_SPACES). Past it the tail is not shown —
    // far beyond any real Space count; a rejected setState would instead take the whole native chrome down.
    const list = all.slice(0, MAX_SPACES)
    const defs = useSpaceStore.getState().spaces
    const sources = list.map((sp) => defs.find((d) => d.id === sp.id)?.icon)
    const drawn = sources.map((src) => (src?.imageUrl ? src.nativeFallback : src))
    // pictures of Spaces that are gone (a plugin was updated or removed) do not stay cached for the rest of the session
    const live = new Set(sources.map((src) => src?.imageUrl))
    for (const url of [...spacePngs.keys()]) if (!live.has(url)) spacePngs.delete(url)
    const missing = [...new Set(drawn.filter((src) => src && !spaceIcons.has(src)))]
    if (missing.length) (await renderNativeIcons(missing as never[])).forEach((icon, i) => spaceIcons.set(missing[i], icon))
    let budget = MAX_SPACE_PNGS_CHARS
    return list.map((sp, i) => {
      const icon = drawn[i] ? spaceIcons.get(drawn[i]) : undefined
      const png = spacePng(sources[i]?.imageUrl)
      const fits = !!png && png.length <= budget
      if (fits) budget -= png.length
      // A Space's name can now come from a plugin's recipe: Kotlin refuses a label over 128 — and with it the whole bar.
      return { ...sp, label: String(sp.label ?? '').slice(0, 120), ...(icon ? { icon } : {}), ...(fits ? { png } : {}) }
    })
  }
  // Account avatar: the picture (converted once per source string), else the initial, else — signed out — a person glyph.
  const guest: Promise<NativeIcon | undefined> = renderNativeIcons([UserRound]).then(([icon]) => icon)
  // The picture never holds up a bar update (a remote one can take as long as the network likes): the bar is sent with
  // the initial first and once more when the picture is ready.
  let picture: { src: string; png: string | null } | null = null
  const account = async (): Promise<ChromeAccount | null> => {
    const chip = accountChip()
    if (!chip) return null
    if (chip.avatar && picture?.src !== chip.avatar) {
      const mine = picture = { src: chip.avatar, png: null as string | null }
      void squarePng(mine.src, AVATAR_PX, MAX_AVATAR_CHARS).then((png) => { if (png && picture === mine) { mine.png = png; send() } })
    }
    const png = chip.avatar && picture?.src === chip.avatar ? picture.png : null
    const icon = chip.loggedIn ? { kind: 'text' as const, text: chip.initial } : await guest
    return { label: chip.label.slice(0, 120), ...(icon ? { icon } : {}), ...(png ? { png } : {}) } // Kotlin refuses a label over 128
  }
  const withBadges = <T extends NativeChromeSpace>(list: T[]): Array<T & { badge?: ChromeBadge }> => {
    const badges = spaceBadges()
    return list.map((sp) => { const kind = badges[sp.id]; return kind ? { ...sp, badge: { kind, label: BADGE_LABEL[kind]() } } : sp })
  }
  let state: NativeChromeState | null = null
  let lastSent = ''
  let chain: Promise<void> = Promise.resolve()
  let uninstall: (() => void) | null = null

  const send = (): void => {
    chain = chain.then(async () => {
      if (!state || !uninstall) return
      const current = state
      const base = await icons
      // The shell sends `spaces` exactly on first-level pages (a Space's list, a root page): the avatar lives there too.
      const avatar = current.mode === 'shell' && current.spaces ? await account() : null
      const payload = {
        // two-level navigation, detail level: the left button goes back to the Space's list → back arrow, not the panel icon
        ...current, theme: readNativeTheme(), icons: current.mode === 'shell' && current.leftBack ? { ...base, left: base.back } : base,
        ...(current.mode === 'shell' && current.spaces ? { spaces: withBadges(await withIcons(current.spaces)) } : {}),
        ...(avatar ? { account: avatar } : {}),
        // The shell's own pages run under the chrome. A page / overlay that took the bar does not: it never learned to
        // keep clear of the capsules, so Kotlin keeps the WebView between two strips for it.
        ...(current.mode === 'shell' ? { floating: true, frosted: pageFrosts() } : {}),
      }
      const key = JSON.stringify(payload)
      if (key === lastSent) return
      try {
        await plugin.setState(payload)
        lastSent = key
      } catch (e) {
        // Broken native side: never leave the user without a top bar.
        console.error('[tangu-mobile] native chrome failed, falling back to web top bar:', e)
        uninstall?.(); uninstall = null
        applyChromeLayout(null) // the web bar's shell must not keep room for capsules that are not there
        void plugin.clear().catch(() => {})
      }
    })
  }

  void plugin.addListener('action', (e) => {
    if ((e.action === 'space' || e.action === 'spaceLong') && typeof e.id === 'string') dispatchNativeChromeSpace(e.id, e.action === 'spaceLong')
    // The avatar exists only on a first-level shell page: a tap that arrives after a page / overlay took the bar
    // (settings, a sheet) or after the shell went one level down must not open the account menu over it.
    else if (e.action === 'account') { if (state?.mode === 'shell' && state.spaces) accountChip()?.activate() }
    else if ((ACTIONS as readonly string[]).includes(e.action)) dispatchNativeChromeAction(e.action as NativeChromeAction)
  }).catch(() => {})
  // After a fallback to the web bar (uninstall === null) a late report must not bring the capsules' room back.
  void plugin.addListener('layout', (e) => { if (uninstall) applyChromeLayout(e) }).catch(() => {})
  // Skin / mode / custom colour changes repaint the bar (same attributes the model picker watches + inline vars);
  // switching glass off makes the capsules solid.
  new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-skin', 'data-bg', 'data-theme', 'data-glass', 'style', 'class'] })
  subscribeAccountChip(send) // sign-in / sign-out / a new picture repaints the avatar
  // Badges: the stores change far more often than the answer does (every streamed token touches useApp) → re-send only
  // when the set of dots changed.
  let badgeKey = JSON.stringify(spaceBadges())
  const onStores = (): void => { const key = JSON.stringify(spaceBadges()); if (key !== badgeKey) { badgeKey = key; send() } }
  useApp.subscribe(onStores); useAttention.subscribe(onStores); useInbox.subscribe(onStores)
  // A reload (or the auth redirect) tears the native bar down; the new page re-installs and re-pushes.
  uninstall = installNativeChromeHost({
    spaces: true,
    render: (next) => { state = next; send() },
    haptic: (kind) => { void plugin.haptic({ kind }).catch(() => {}) },
  })
}
