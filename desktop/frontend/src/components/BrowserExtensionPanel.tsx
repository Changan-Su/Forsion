import { homeTarget } from '../services/engine/targets'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, FolderOpen, GripVertical, Puzzle, RefreshCw } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getBrowserExtension, resetBrowserExtensionCode, type BrowserExtensionStatus } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'

registerMessages({
  'settings.browserExt.title': { zh: 'Chrome 扩展（Forsion Clip）', en: 'Chrome extension (Forsion Clip)' },
  'settings.browserExt.hint': {
    zh: 'Forsion Clip 把网页剪藏进你的智库；配对后，Tangu 还能看到你打开的标签页和你正在看的那一个，并在自己的「Tangu」标签组里后台操作，不占用你正在看的页面，也不会再弹「允许远程调试」。',
    en: 'Forsion Clip saves web pages to your vault. Once paired, Tangu can also see your open tabs and the one you are looking at, and works in its own “Tangu” tab group in the background, without taking over your page or asking to allow remote debugging.',
  },
  'settings.browserExt.status': { zh: '状态', en: 'Status' },
  'settings.browserExt.connected': { zh: '已连接', en: 'Connected' },
  'settings.browserExt.notConnected': { zh: '未连接', en: 'Not connected' },
  'settings.browserExt.portBusy': { zh: '端口 {port} 不可用：{error}', en: 'Port {port} is unavailable: {error}' },
  'settings.browserExt.unavailable': { zh: '当前引擎不支持 Chrome 扩展（需要本机引擎）。', en: 'The current engine does not support the Chrome extension (a local engine is required).' },
  'settings.browserExt.code': { zh: '连接码', en: 'Connect code' },
  'settings.browserExt.codeHint': { zh: '粘贴到 Forsion Clip 的设置里即可配对，只需要一次。', en: 'Paste it into Forsion Clip settings to pair. You only need to do this once.' },
  'settings.browserExt.copy': { zh: '复制', en: 'Copy' },
  'settings.browserExt.copied': { zh: '已复制', en: 'Copied' },
  'settings.browserExt.reset': { zh: '换一个', en: 'New code' },
  'settings.browserExt.resetConfirm': { zh: '换码后，已配对的扩展会断开，需要重新粘贴。继续吗？', en: 'Paired extensions will disconnect and need the new code. Continue?' },
  'settings.browserExt.install': { zh: '安装步骤', en: 'How to install' },
  'settings.browserExt.step1': { zh: '点「在 Chrome 中打开扩展页」（或在地址栏打开 chrome://extensions），打开右上角的「开发者模式」。', en: 'Click “Open extensions in Chrome” (or open chrome://extensions), then turn on Developer mode (top right).' },
  'settings.browserExt.step2': {
    zh: '把下面的「Forsion Clip」拖到扩展页上。拖不动就点「加载已解压的扩展程序」，选择扩展文件夹（mac 在选择框里按 ⌘⇧G 粘贴路径）。',
    en: 'Drag “Forsion Clip” below onto the extensions page. If that doesn’t work, click “Load unpacked” and choose the extension folder (on Mac, press ⌘⇧G in the dialog and paste the path).',
  },
  'settings.browserExt.step3': { zh: '打开 Forsion Clip 的设置 ›「桌面联动与 MCP」，粘贴上面的连接码。', en: 'Open Forsion Clip settings › Desktop & MCP and paste the connect code above.' },
  'settings.browserExt.step4': { zh: '要把剪藏存进本机智库：在同一页点「请求配对」，再在 Forsion 桌面确认这个配对请求。', en: 'To save clips to your local vault, click “Request pairing” on the same page, then approve the pairing request in Forsion Desktop.' },
  'settings.browserExt.openFolder': { zh: '打开扩展文件夹', en: 'Open extension folder' },
  'settings.browserExt.openChrome': { zh: '在 Chrome 中打开扩展页', en: 'Open extensions in Chrome' },
  'settings.browserExt.addressCopied': { zh: '已复制扩展页地址，粘贴到 Chrome 地址栏打开。', en: 'Copied the address. Paste it into the Chrome address bar.' },
  'settings.browserExt.noChrome': { zh: '没找到 Google Chrome。已复制扩展页地址，在 Chrome 地址栏粘贴打开。', en: 'Google Chrome was not found. The address is copied. Paste it into the Chrome address bar.' },
  'settings.browserExt.dragHint': { zh: '拖到 Chrome 扩展页上安装', en: 'Drag onto the Chrome extensions page to install' },
  'settings.browserExt.dragSub': { zh: '扩展文件夹 · {version}', en: 'Extension folder · {version}' },
  'settings.browserExt.copyPath': { zh: '复制路径', en: 'Copy path' },
  'settings.browserExt.folder': { zh: '扩展文件夹', en: 'Extension folder' },
  'settings.browserExt.remoteDir': {
    zh: '当前连接的是外部引擎：扩展要装在引擎所在的那台电脑上，从这个文件夹加载：{dir}',
    en: 'You are connected to an external engine. Install the extension on the computer running that engine, from this folder: {dir}',
  },
})

/**
 * 设置 → 浏览器:Chrome 扩展(Forsion Clip,并入了原 Tangu for Chrome)的状态、连接码与安装步骤(连接状态 3 秒刷新一次)。
 * managed=false(外部引擎):扩展目录在引擎那台机器上,本机「打开文件夹」没有意义 → 只给路径与说明。
 */
export function BrowserExtensionPanel({ cfg, managed = true }: { cfg: TanguDesktopConfig; managed?: boolean }): React.ReactElement {
  const { t } = useI18n()
  const [info, setInfo] = useState<BrowserExtensionStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [openNote, setOpenNote] = useState('')
  // 随包扩展复制到用户找得到的位置(主进程,版本变了才覆盖);只有本机引擎 + 桌面壳才有
  const [clipCopy, setClipCopy] = useState<{ dir: string; version: string } | null>(null)
  const clipApi = managed ? window.tangu?.clipExtension : undefined
  const [resetting, setResetting] = useState(false) // 换码不并发:两次换码乱序返回会留下已作废的码(Codex 09-24)
  // 请求代次:换码 / 换引擎之后才回来的旧轮询结果一律丢弃,免得把新码盖回旧码(Codex 09-24)
  const gen = useRef(0)
  const cfgNow = useRef(cfg)

  const load = useCallback(async () => {
    const mine = gen.current
    try {
      const next = await getBrowserExtension(homeTarget())
      if (mine === gen.current) { setInfo(next); setUnavailable(false) }
    } catch {
      if (mine === gen.current) setUnavailable(true)
    }
  }, [cfg])
  useEffect(() => { gen.current++; cfgNow.current = cfg; setInfo(null); setResetting(false) }, [cfg])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 3000)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!clipApi) return
    let live = true
    void clipApi.prepare().then((r) => { if (live && 'dir' in r) setClipCopy(r) }).catch(() => { /* 退回引擎报的随包目录 */ })
    return () => { live = false }
  }, [clipApi])
  const openChrome = async (): Promise<void> => {
    const r = await clipApi?.openChromeExtensions().catch(() => null)
    setOpenNote(r && !r.ok ? t(r.reason === 'no-chrome' ? 'settings.browserExt.noChrome' : 'settings.browserExt.addressCopied') : '')
  }
  const copyPath = async (dir: string): Promise<void> => {
    try { await navigator.clipboard.writeText(dir); setCopiedPath(true); window.setTimeout(() => setCopiedPath(false), 1500) } catch { /* 剪贴板不可用时路径仍可手选 */ }
  }
  const copy = async (): Promise<void> => {
    if (!info?.code) return
    try { await navigator.clipboard.writeText(info.code); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { /* 剪贴板不可用时用户仍可手选 */ }
  }
  const reset = async (): Promise<void> => {
    if (!window.confirm(t('settings.browserExt.resetConfirm'))) return
    const mine = ++gen.current
    setResetting(true)
    // 回来时再推一代:换码途中发出的轮询(可能先于换码到达引擎)一并作废
    try { const next = await resetBrowserExtensionCode(homeTarget()); if (mine === gen.current) { gen.current++; setInfo(next) } } catch { /* 下次轮询会刷新 */ } finally { if (cfgNow.current === cfg) setResetting(false) } // 换了引擎就不替新引擎那次换码解除置灰
  }

  const status = unavailable
    ? t('settings.browserExt.unavailable')
    : info && !info.listening && info.error
      ? t('settings.browserExt.portBusy', { port: String(info.port), error: info.error })
      : info?.connected ? t('settings.browserExt.connected') : t('settings.browserExt.notConnected')

  return (
    <SettingsPanel className="settings-browser-ext-panel" icon={<Puzzle size={16} />} title={t('settings.browserExt.title')} description={t('settings.browserExt.hint')}>
      <div className="settings-control-list" data-testid="browser-extension-panel">
        <SettingsRow label={t('settings.browserExt.status')} control={<span className="hint" data-testid="browser-extension-status">{status}</span>} />
        {!unavailable && info && (
          <SettingsRow
            label={t('settings.browserExt.code')}
            description={t('settings.browserExt.codeHint')}
            control={(
              <div className="settings-inline-actions">
                <code className="settings-code-chip" data-testid="browser-extension-code">{info.code}</code>
                <button type="button" className="btn ghost sm" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t('settings.browserExt.copied') : t('settings.browserExt.copy')}</button>
                <button type="button" className="btn ghost sm" disabled={resetting} onClick={() => void reset()}><RefreshCw size={12} />{t('settings.browserExt.reset')}</button>
              </div>
            )}
          />
        )}
        {!unavailable && info && (
          <SettingsRow
            label={t('settings.browserExt.install')}
            description={(['settings.browserExt.step1', 'settings.browserExt.step2', 'settings.browserExt.step3', 'settings.browserExt.step4'] as const).map((k, i) => (
              <React.Fragment key={k}>{i > 0 && <br />}{`${i + 1}. ${t(k)}`}</React.Fragment>
            )).concat(openNote ? [<React.Fragment key="note"><br /><span data-testid="browser-extension-open-note">{openNote}</span></React.Fragment>] : [])}
            control={clipApi ? (
              <button type="button" className="btn ghost sm" onClick={() => void openChrome()} data-testid="browser-extension-open-chrome">
                <ExternalLink size={12} />{t('settings.browserExt.openChrome')}
              </button>
            ) : managed ? (
              <button type="button" className="btn ghost sm" onClick={() => { void window.tangu?.openHostPath?.(info.extensionDir) }}>
                <FolderOpen size={12} />{t('settings.browserExt.openFolder')}
              </button>
            ) : undefined}
          />
        )}
        {!unavailable && info && clipCopy && (
          <SettingsRow
            label={t('settings.browserExt.folder')}
            description={<code className="settings-path-text">{clipCopy.dir}</code>}
            control={(
              <div className="settings-inline-actions">
                {/* 原生拖出(fs:startDrag):拖进 Chrome 扩展页即「加载已解压」,只在 Chrome 开发者模式下生效 */}
                <div
                  className="settings-drag-chip"
                  draggable
                  title={t('settings.browserExt.dragHint')}
                  data-testid="browser-extension-drag"
                  onDragStart={(e) => { e.preventDefault(); window.tangu?.startHostDrag?.(clipCopy.dir) }}
                >
                  <GripVertical size={14} className="settings-drag-chip-grip" />
                  <span className="settings-drag-chip-icon"><Puzzle size={14} /></span>
                  <span><b>Forsion Clip</b><small>{t('settings.browserExt.dragSub', { version: clipCopy.version })}</small></span>
                </div>
                <button type="button" className="btn ghost sm" onClick={() => void copyPath(clipCopy.dir)}>{copiedPath ? <Check size={12} /> : <Copy size={12} />}{copiedPath ? t('settings.browserExt.copied') : t('settings.browserExt.copyPath')}</button>
                <button type="button" className="btn ghost sm" onClick={() => { void window.tangu?.openHostPath?.(clipCopy.dir) }}><FolderOpen size={12} />{t('settings.browserExt.openFolder')}</button>
              </div>
            )}
          />
        )}
        {!unavailable && info && !managed && (
          <SettingsRow label={t('settings.browserExt.folder')} description={t('settings.browserExt.remoteDir', { dir: info.extensionDir })} />
        )}
      </div>
    </SettingsPanel>
  )
}
