import { createHash } from 'node:crypto'
import { BrowserWindow, screen, type Rectangle } from 'electron'
import { isDesktopPermissionId, type DesktopPermissionId, type DesktopPermissionRequestOptions,
  type DesktopPermissionsSnapshot, type DesktopPermissionState } from '../shared/desktopPermissions'

export interface PermissionGuideDependencies {
  /** Read cached/native diagnostics only; this must never start the helper or capture the screen. */
  read: () => Promise<{
    snapshot: DesktopPermissionsSnapshot
    settingsWindow?: Rectangle
    settingsFrontmost?: boolean
  }>
  verify: (id: DesktopPermissionId) => Promise<DesktopPermissionsSnapshot>
  open: (id: DesktopPermissionId) => Promise<void>
  returnToApp: () => void
}

const WIDTH = 300, HEIGHT = 520, GAP = 12, POLL_MS = 750
const validRect = (r?: Rectangle): r is Rectangle => !!r &&
  [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max))
const overlap = (a: Rectangle, b: Rectangle) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/** Keep the entire panel inside one work area, including on very small displays. */
export function clampPermissionGuideBounds(bounds: Rectangle, area: Rectangle): Rectangle {
  const marginX = Math.min(GAP, Math.floor((area.width - 1) / 2))
  const marginY = Math.min(GAP, Math.floor((area.height - 1) / 2))
  const left = Math.ceil(area.x + marginX), top = Math.ceil(area.y + marginY)
  const right = Math.floor(area.x + area.width - marginX), bottom = Math.floor(area.y + area.height - marginY)
  const width = Math.max(1, Math.min(Math.round(bounds.width), right - left))
  const height = Math.max(1, Math.min(Math.round(bounds.height), bottom - top))
  return { x: clamp(Math.round(bounds.x), left, right - width),
    y: clamp(Math.round(bounds.y), top, bottom - height), width, height }
}

/** Quartz and Electron DIP both point downwards: do not invert Y or apply display scaleFactor. */
export function permissionGuideBounds(
  workAreas: readonly Rectangle[], settingsWindow?: Rectangle, previous?: Rectangle,
): Rectangle {
  const areas = workAreas.filter(validRect)
  if (!areas.length) throw new Error('No display work area available')
  const settings = validRect(settingsWindow) ? settingsWindow : undefined
  const last = validRect(previous) ? previous : undefined
  const anchor = settings ?? last
  let area = areas[0]
  if (anchor) {
    const cx = anchor.x + anchor.width / 2, cy = anchor.y + anchor.height / 2
    const distance = (r: Rectangle) => (cx - clamp(cx, r.x, r.x + r.width)) ** 2 +
      (cy - clamp(cy, r.y, r.y + r.height)) ** 2
    area = [...areas].sort((a, b) => overlap(anchor, b) - overlap(anchor, a) || distance(a) - distance(b))[0]
  }
  const fit = (x: number, y: number) => clampPermissionGuideBounds({ x, y, width: WIDTH, height: HEIGHT }, area)
  if (!settings) return fit(last?.x ?? area.x + area.width - WIDTH - GAP, last?.y ?? area.y + GAP)
  const size = fit(area.x, area.y)
  const candidates = [
    { x: settings.x + settings.width + GAP, y: settings.y },
    { x: settings.x - size.width - GAP, y: settings.y },
    { x: settings.x, y: settings.y + settings.height + GAP },
    { x: settings.x, y: settings.y - size.height - GAP },
  ].map(point => ({ raw: point, bounds: fit(point.x, point.y) }))
  // Prefer a free side; if none fits, cover as little of Settings as possible.
  candidates.sort((a, b) => overlap(a.bounds, settings) - overlap(b.bounds, settings) ||
    Math.hypot(a.raw.x - a.bounds.x, a.raw.y - a.bounds.y) - Math.hypot(b.raw.x - b.bounds.x, b.raw.y - b.bounds.y))
  return candidates[0].bounds
}

export function escapePermissionGuideHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const ACTION_URLS = {
  close: 'https://permission-guide.invalid/close',
  return: 'https://permission-guide.invalid/return',
  open: 'https://permission-guide.invalid/open',
  verify: 'https://permission-guide.invalid/verify',
} as const
type Action = keyof typeof ACTION_URLS

/** Exact matching intentionally rejects query strings, fragments, credentials and lookalike hosts. */
export function permissionGuideAction(url: string): Action | undefined {
  return (Object.keys(ACTION_URLS) as Action[]).find(action => ACTION_URLS[action] === url)
}

const COPY = {
  en: {
    title: 'Permission guide', close: 'Close', app: 'App to authorize',
    names: { computerAccessibility: 'Accessibility', computerScreen: 'Screen recording',
      microphone: 'Microphone', camera: 'Camera', screen: 'Screen recording' },
    path: 'In System Settings → Privacy & Security, find',
    screenPath: 'On newer macOS versions, this is called “Screen & System Audio Recording”.',
    enable: 'Turn on the switch beside the app shown above.',
    add: 'App missing? If this page has a + button, click it and add the app shown above. Otherwise, return to Forsion and request this permission again.',
    restart: 'Already on but still not working? Follow any system prompt to quit and reopen the app. This guide never restarts an app for you.',
    next: 'This permission is ready. Return to Forsion and click the next permission you want to set up.',
    back: 'Return to Forsion', verify: 'Verify', open: 'Reopen settings', busy: 'Working…',
    loading: 'Reading permission status…', error: 'Could not read permission status. You can retry or close this guide.',
    actionError: 'The action failed. Try again or return to Forsion.',
    unverified: 'Screen access has not been verified. Click Verify; an enabled switch alone does not confirm it works.',
    states: { granted: 'Granted', denied: 'Not enabled', 'not-determined': 'Not requested',
      restricted: 'Restricted by the system', unknown: 'Status unknown', unverified: 'Not verified',
      unavailable: 'Currently unavailable', 'not-required': 'Not required on this system' },
    drag: 'Drag this header to move the guide',
  },
  zh: {
    title: '权限辅助', close: '关闭', app: '需要授权的应用',
    names: { computerAccessibility: '辅助功能', computerScreen: '屏幕录制',
      microphone: '麦克风', camera: '摄像头', screen: '屏幕录制' },
    path: '前往「系统设置 → 隐私与安全性」，找到',
    screenPath: '较新版 macOS 中，此项名称为「屏幕与系统音频录制」。',
    enable: '打开上方应用名称旁的开关。',
    add: '找不到应用？如果页面有「+」按钮，点它添加上方应用；若没有，请返回 Forsion 再次请求此权限。',
    restart: '已开启但仍无效？请按系统提示退出并重新打开应用。此辅助窗口不会自动重启应用。',
    next: '当前权限已就绪。请返回 Forsion，主动点击下一项需要设置的权限。',
    back: '返回 Forsion', verify: '验证', open: '重新打开设置', busy: '处理中…',
    loading: '正在读取权限状态…', error: '无法读取权限状态，可重试或关闭辅助窗口。',
    actionError: '操作失败，请重试或返回 Forsion。',
    unverified: '屏幕访问尚未验证。请点击「验证」；仅开关开启不代表实际可用。',
    states: { granted: '已授权', denied: '未开启', 'not-determined': '尚未请求',
      restricted: '受系统限制', unknown: '状态未知', unverified: '尚未验证',
      unavailable: '当前不可用', 'not-required': '此系统无需授权' },
    drag: '拖动此标题栏可移动辅助窗口',
  },
} satisfies Record<'zh' | 'en', { names: Record<DesktopPermissionId, string>; states: Record<DesktopPermissionState, string> } & Record<string, unknown>>

// Standalone token defaults match base.css. Use native shadow; no CSS elevation bypasses --card-shadow.
const STYLE = `
:root{color-scheme:light;--bg:#f8f7f6;--bg-card:#fdfdfc;--text:#1c1c1c;--text-muted:#5f5f5d;--border:#eae9e7;--green:#4f6f52;--danger:#a3503f}
:root[data-mode=dark]{color-scheme:dark;--bg:#2a292b;--bg-card:#353538;--text:#f2efe8;--text-muted:#aca59b;--border:#3f3f43;--green:#8fb295;--danger:#d99080}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}body{background:var(--bg-card);color:var(--text);font:13px/1.5 system-ui,-apple-system,'PingFang SC',sans-serif;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:8px;padding:12px 16px 8px;flex-shrink:0;-webkit-app-region:drag;font-size:12px;color:var(--text-muted)}header span{flex:1}a{-webkit-app-region:no-drag;color:inherit;text-decoration:none}a:focus-visible{outline:2px solid var(--text);outline-offset:2px}header a{font-size:20px;line-height:24px;width:24px;text-align:center;border-radius:6px}
main{min-height:0;overflow:auto;padding:4px 18px 14px;overflow-wrap:anywhere}h1{font-size:19px;line-height:1.3;margin:4px 0 16px}p{margin:10px 0}.app{background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:14px}.app small{display:block;color:var(--text-muted);margin-bottom:3px}.app strong{user-select:text}small,.note{font-size:12px;color:var(--text-muted)}.status{font-weight:600}.success{color:var(--green)}.error{color:var(--danger)}
footer{flex-shrink:0;display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px 14px;background:var(--bg-card)}footer a,footer span{border:1px solid var(--border);border-radius:8px;padding:7px 10px;text-align:center;flex:1;white-space:normal}footer .back{flex-basis:100%;background:var(--text);color:var(--bg-card);border-color:transparent}footer span{color:var(--text-muted)}a:hover{background:var(--bg)}footer .back:hover{opacity:.85}
@media(max-height:320px){header{padding-top:6px}footer{padding-block:6px;gap:4px}footer a,footer span{padding-block:4px}}
`
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64')

export interface PermissionGuideView {
  id: DesktopPermissionId
  options?: DesktopPermissionRequestOptions
  snapshot?: DesktopPermissionsSnapshot
  error?: 'read' | 'action'
  busy?: boolean
}

export function permissionGuideHtml(view: PermissionGuideView): string {
  const locale = view.options?.locale === 'zh' ? 'zh' : 'en'
  const mode = view.options?.mode === 'dark' ? 'dark' : 'light'
  const t = COPY[locale], esc = escapePermissionGuideHtml
  const state = view.snapshot?.permissions[view.id]
  const ready = state === 'granted' || state === 'not-required'
  const name = t.names[view.id]
  const appName = view.id === 'computerAccessibility' || view.id === 'computerScreen'
    ? 'tangu-computer-use' : view.snapshot?.appName || 'Forsion'
  const action = (id: Action, label: string, className = '') =>
    `<a class="${className}" href="${ACTION_URLS[id]}">${esc(label)}</a>`
  return `<!doctype html><html lang="${locale}" data-mode="${mode}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'sha256-${STYLE_HASH}'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)}</title><style>${STYLE}</style></head><body>
<header title="${esc(t.drag)}"><span>${esc(t.title)}</span><a href="${ACTION_URLS.close}" aria-label="${esc(t.close)}">×</a></header>
<main><h1>${esc(name)}</h1><div class="app"><small>${esc(t.app)}</small><strong>${esc(appName)}</strong></div>
<p>${esc(t.path)} <strong>${esc(name)}</strong>${locale === 'zh' ? '。' : '.'}</p>
${view.id === 'computerScreen' || view.id === 'screen' ? `<p class="note">${esc(t.screenPath)}</p>` : ''}
<p>${esc(t.enable)}</p><p class="note">${esc(t.add)}</p><p class="note">${esc(t.restart)}</p>
<div role="status" aria-live="polite"><p class="status ${view.error ? 'error' : ready ? 'success' : ''}">${esc(view.error ? (view.error === 'read' ? t.error : t.actionError) : state ? t.states[state] : t.loading)}</p>
${!view.error && ready ? `<p>${esc(t.next)}</p>` : ''}
${!view.error && state === 'unverified' ? `<p class="note">${esc(t.unverified)}</p>` : ''}</div></main>
<footer>${view.busy ? `<span>${esc(t.busy)}</span>` : action('verify', t.verify) + action('open', t.open)}${action('return', t.back, 'back')}</footer>
</body></html>`
}

interface GuideSession extends PermissionGuideView {
  settingsWindow?: Rectangle
  settingsFrontmost?: boolean
  fallbackBounds?: Rectangle
}

/** Main-process only. Construct after app.ready; show does not itself open settings or request a grant. */
export class PermissionGuide {
  private static active?: PermissionGuide
  private window?: BrowserWindow
  private current?: GuideSession
  private displayed?: GuideSession
  private timer?: ReturnType<typeof setTimeout>
  // Keep this queue across close/show: even an old, slow read must not overlap a new read.
  private pending: Promise<void> = Promise.resolve()
  private html = ''

  constructor(private readonly deps: PermissionGuideDependencies) {}

  async show(id: DesktopPermissionId, options?: DesktopPermissionRequestOptions): Promise<void> {
    if (!isDesktopPermissionId(id)) throw new Error('Invalid desktop permission')
    if (PermissionGuide.active && PermissionGuide.active !== this) PermissionGuide.active.close()
    PermissionGuide.active = this
    this.stopTimer()
    const view: GuideSession = { id, options: { ...options } }
    this.current = view
    this.displayed = undefined
    if (!this.window || this.window.isDestroyed()) this.window = this.createWindow()
    // Reuse the window, but never let old buttons act on a newly selected target.
    await this.enqueue(view, async () => {
      await this.render(view)
      await this.refresh(view)
    })
    this.schedule(view)
  }

  close(): void {
    this.stopTimer()
    this.current = undefined
    this.displayed = undefined
    this.html = ''
    const win = this.window
    this.window = undefined
    if (PermissionGuide.active === this) PermissionGuide.active = undefined
    if (win && !win.isDestroyed()) win.destroy()
  }

  private createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      ...permissionGuideBounds(this.workAreas()), type: 'panel', show: false, frame: false,
      skipTaskbar: true, alwaysOnTop: true, movable: true, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, closable: true,
      hasShadow: true, backgroundColor: this.current?.options?.mode === 'dark' ? '#353538' : '#fdfdfc',
      webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true,
        javascript: false, webSecurity: true, devTools: false, webviewTag: false,
        partition: 'permission-guide' },
    })
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      const action = permissionGuideAction(url)
      if (action && this.current && this.displayed === this.current) this.act(this.current, action)
    })
    win.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame) event.preventDefault()
    })
    win.webContents.on('will-redirect', event => event.preventDefault())
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.close() }
    })
    win.webContents.on('render-process-gone', () => { if (this.window === win) this.close() })
    win.on('closed', () => { if (this.window === win) this.close() })
    win.on('blur', () => { if (this.current && this.window === win) this.visibility(this.current) })
    win.on('moved', () => {
      if (this.current && this.window === win && !validRect(this.current.settingsWindow)) {
        this.current.fallbackBounds = win.getBounds()
      }
    })
    return win
  }

  private alive(view: GuideSession): boolean {
    return this.current === view && !!this.window && !this.window.isDestroyed()
  }

  /** All event/timer jobs resolve, including dependency and renderer failures. */
  private enqueue(view: GuideSession, job: () => Promise<void>): Promise<void> {
    const task = this.pending.then(async () => {
      if (!this.alive(view)) return
      try { await job() } catch {
        if (!this.alive(view)) return
        view.error = 'action'
        view.busy = false
        try { await this.render(view) } catch { if (this.alive(view)) this.close() }
      }
    })
    this.pending = task.catch(() => { if (this.alive(view)) this.close() })
    return this.pending
  }

  private async refresh(view: GuideSession): Promise<void> {
    if (!this.alive(view)) return
    try {
      const result = await this.deps.read()
      if (!this.alive(view)) return
      view.snapshot = result.snapshot
      view.settingsWindow = validRect(result.settingsWindow) ? result.settingsWindow : undefined
      view.settingsFrontmost = result.settingsFrontmost
      if (view.error === 'read') view.error = undefined
    } catch {
      if (!this.alive(view)) return
      view.error = 'read'
    }
    if (this.alive(view)) await this.render(view)
  }

  private schedule(view: GuideSession): void {
    if (!this.alive(view)) return
    this.stopTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.enqueue(view, () => this.refresh(view)).then(() => this.schedule(view))
    }, POLL_MS)
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private workAreas(): Rectangle[] {
    const primary = screen.getPrimaryDisplay()
    return [primary, ...screen.getAllDisplays().filter(d => d.id !== primary.id)].map(d => d.workArea)
  }

  private visibility(view: GuideSession): void {
    if (!this.alive(view)) return
    const win = this.window!
    // Unknown frontmost (e.g. media-only, no helper) retains the draggable fallback.
    if (view.settingsFrontmost === false && !win.isFocused()) win.hide()
    else if (!win.isVisible() && this.displayed === view) win.showInactive()
  }

  private async render(view: GuideSession): Promise<void> {
    if (!this.alive(view)) return
    const win = this.window!
    const bounds = permissionGuideBounds(this.workAreas(), view.settingsWindow, view.fallbackBounds)
    const current = win.getBounds()
    if (Object.keys(bounds).some(key => bounds[key as keyof Rectangle] !== current[key as keyof Rectangle])) win.setBounds(bounds, false)
    const html = permissionGuideHtml(view)
    if (html !== this.html) {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      if (!this.alive(view)) return
      this.html = html
    }
    this.displayed = view
    this.visibility(view)
  }

  private act(view: GuideSession, action: Action): void {
    if (!this.alive(view)) return
    if (action === 'close') { this.close(); return }
    if (action === 'return') {
      try { this.deps.returnToApp(); this.close() } catch {
        view.error = 'action'
        void this.enqueue(view, () => this.render(view))
      }
      return
    }
    if (view.busy) return
    view.busy = true
    view.error = undefined
    void this.enqueue(view, async () => {
      await this.render(view)
      if (!this.alive(view)) return
      try {
        if (action === 'verify') {
          const snapshot = await this.deps.verify(view.id)
          if (this.alive(view)) view.snapshot = snapshot
        } else await this.deps.open(view.id)
      } catch {
        if (this.alive(view)) view.error = 'action'
      } finally {
        if (this.alive(view)) { view.busy = false; await this.render(view) }
      }
    })
  }
}
