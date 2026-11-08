/**
 * 语音输入胶囊的窗口:桌面作用域 · 下居中 · 用途 notice · 不抢焦点 · pin(要盖在用户正在打字的应用上)。
 * 服务一开就预先建好藏着 —— 按快捷键只 showInactive,不等页面加载,手感是「按下就听」。
 * 页面是单独的轻量入口 dictation.html(不起引擎、不装插件),preload 是只给听写用的那份(dictationPreload)。
 */
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { DICTATION_CAPSULE_CHANNELS, type DictationState } from '../../shared/dictation'
import { createDesktopFloat, presentDesktopFloat, type DesktopFloatOptions } from '../desktopFloat'

const LAYOUT: Pick<DesktopFloatOptions, 'anchor' | 'width' | 'height' | 'margin' | 'focus'> = {
  anchor: 'bottom-center',
  // 胶囊本身 ≈ 400×52;四周留出卡面阴影的位置
  width: 440,
  height: 96,
  margin: 20,
  focus: 'keep',
}

export interface CapsuleWindow {
  prepare(): void
  show(): void
  hide(): void
  send(state: DictationState): void
  dispose(): void
  /** 胶囊页的 webContents id(只认它交回来的文字);没建 = -1。 */
  contentsId(): number
  window(): BrowserWindow | null
}

export function createCapsuleWindow(o: { dirname: string; rendererUrl?: string; title: string }): CapsuleWindow {
  let win: BrowserWindow | null = null
  let loaded = false
  let last: DictationState | null = null

  const flush = (): void => {
    if (win && !win.isDestroyed() && loaded && last) win.webContents.send(DICTATION_CAPSULE_CHANNELS.state, last)
  }
  const prepare = (): void => {
    if (win && !win.isDestroyed()) return
    loaded = false
    const w = createDesktopFloat({
      ...LAYOUT,
      role: 'notice',
      pin: true,
      title: o.title,
      webPreferences: {
        preload: join(o.dirname, '../preload/dictationPreload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // ESM preload(同 satelliteWebPreferences 的理由);页面本身没有 Node
        backgroundThrottling: false, // 藏着 / 被盖住时也要按时录音、收转写
        autoplayPolicy: 'no-user-gesture-required', // 全局快捷键不算页面里的手势:不放开的话 AudioContext 起不来,流式转写收不到声音
        spellcheck: false,
        webviewTag: false,
      },
    })
    win = w
    w.webContents.on('did-finish-load', () => { if (win === w) { loaded = true; flush() } })
    w.webContents.on('render-process-gone', () => { if (win === w) { win = null; loaded = false; if (!w.isDestroyed()) w.destroy() } })
    w.on('closed', () => { if (win === w) { win = null; loaded = false } })
    if (o.rendererUrl) void w.loadURL(new URL('dictation.html', o.rendererUrl.endsWith('/') ? o.rendererUrl : o.rendererUrl + '/').href)
    else void w.loadFile(join(o.dirname, '../renderer/dictation.html'))
  }
  return {
    prepare,
    show() {
      prepare()
      if (win) presentDesktopFloat(win, LAYOUT)
    },
    hide() { if (win && !win.isDestroyed() && win.isVisible()) win.hide() },
    send(state) { last = state; flush() },
    dispose() {
      const w = win
      win = null
      loaded = false
      last = null
      if (w && !w.isDestroyed()) w.destroy()
    },
    contentsId: () => (win && !win.isDestroyed() ? win.webContents.id : -1),
    window: () => win,
  }
}
