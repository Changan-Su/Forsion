import { homeTarget } from '../services/engine/targets'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, FolderOpen, GripVertical, Puzzle, RefreshCw } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getBrowserExtension, resetBrowserExtensionCode, type BrowserExtensionStatus } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useApp } from '../stores/appStore'
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
  'settings.browserExt.connectedVersion': { zh: '已连接 · Forsion Clip {version}', en: 'Connected · Forsion Clip {version}' },
  'settings.browserExt.notInstalled': { zh: '未安装', en: 'Not installed' },
  'settings.browserExt.portBusy': { zh: '端口 {port} 不可用：{error}', en: 'Port {port} is unavailable: {error}' },
  'settings.browserExt.unavailable': { zh: '当前引擎不支持 Chrome 扩展（需要本机引擎）。', en: 'The current engine does not support the Chrome extension (a local engine is required).' },
  'settings.browserExt.code': { zh: '连接码', en: 'Connect code' },
  'settings.browserExt.codeHint': { zh: '粘贴到 Forsion Clip 的设置 ›「桌面联动与 MCP」，只需要一次。', en: 'Paste it into Forsion Clip settings › Desktop & MCP. You only need to do this once.' },
  'settings.browserExt.manual': { zh: '手动配对', en: 'Pair manually' },
  'settings.browserExt.manualHint': { zh: '用连接码配对浏览器控制，外部引擎或连不上时用。', en: 'Pair browser control with a connect code, for an external engine or if it can’t connect.' },
  'settings.browserExt.show': { zh: '展开', en: 'Show' },
  'settings.browserExt.hide': { zh: '收起', en: 'Hide' },
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
  'settings.browserExt.step3': {
    zh: '装好后 Clip 会打开欢迎页并请求连接：在 Forsion 弹出的确认框里核对配对码，点「允许」。剪藏和浏览器控制一次配好。',
    en: 'Once installed, Clip opens a welcome page and asks to connect. Check the pairing code in the Forsion prompt and click Allow. Clipping and browser control are set up in one go.',
  },
  'settings.browserExt.step3HostOff': {
    zh: '要让 Clip 一次配好，先在「设置 › 设备」打开「允许其他设备连接本机」。不想打开也行：展开下面的「手动配对」，把连接码粘到 Clip 里（这样只有浏览器控制，剪藏存不进本机智库）。',
    en: 'For one-step pairing, first turn on Settings › Devices › Allow other devices to connect. Or open “Pair manually” below and paste the connect code into Clip (browser control only; clips can’t go into your local vault).',
  },
  'settings.browserExt.openFolder': { zh: '打开扩展文件夹', en: 'Open extension folder' },
  'settings.browserExt.openChrome': { zh: '在 Chrome 中打开扩展页', en: 'Open extensions in Chrome' },
  'settings.browserExt.addressCopied': { zh: '已复制扩展页地址，粘贴到 Chrome 地址栏打开。', en: 'Copied the address. Paste it into the Chrome address bar.' },
  'settings.browserExt.noChrome': { zh: '没找到 Google Chrome。已复制扩展页地址，在 Chrome 地址栏粘贴打开。', en: 'Google Chrome was not found. The address is copied. Paste it into the Chrome address bar.' },
  'settings.browserExt.dragHint': { zh: '拖到 Chrome 扩展页上安装', en: 'Drag onto the Chrome extensions page to install' },
  'settings.browserExt.dragSub': { zh: '拖到 Chrome 扩展页上安装 · {version}', en: 'Drag onto the Chrome extensions page · {version}' },
  'settings.browserExt.copyPath': { zh: '复制路径', en: 'Copy path' },
  'settings.browserExt.updateHint': { zh: '有新版本 {version}：再拖一次（或重新加载已解压的扩展程序）就会更新。', en: 'Version {version} is available. Drag it in again (or load it unpacked again) to update.' },
  'settings.browserExt.copyFailed': { zh: '扩展文件夹没准备好（{error}），请打开随包的扩展文件夹手动加载。', en: 'Couldn’t prepare the extension folder ({error}). Open the bundled extension folder and load it manually.' },
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
  // 随包扩展复制到用户找得到的位置(主进程);只有本机引擎 + 桌面壳才有。挂载时只补缺,换版本留到用户(重新)装的那一下
  const [clipCopy, setClipCopy] = useState<{ dir: string; version: string; bundled: string } | null>(null)
  const [clipError, setClipError] = useState('')
  const clipApi = managed ? window.tangu?.clipExtension : undefined
  const hostOn = useApp((st) => !!st.desktopConfig?.unitHostEnabled) // 一次配对走设备配对(本机 Unit 口):「允许其他设备连接本机」关着时 Clip 连不上来
  const [manualOpen, setManualOpen] = useState<boolean | null>(null) // null = 跟缺省:外部引擎或互联关着时展开
  const showManual = manualOpen ?? (!managed || !hostOn)
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

  const applyClip = (r: { dir: string; version: string; bundled: string } | { error: string }): string | null => {
    if ('dir' in r) { setClipCopy(r); setClipError(''); return r.dir }
    setClipCopy(null); setClipError(r.error) // 准备失败:退回打开随包目录(Codex 10-20)
    return null
  }
  useEffect(() => {
    setClipCopy(null); setClipError('')
    if (!clipApi) return
    let live = true
    void clipApi.prepare().then((r) => { if (live) applyClip(r) }).catch((e: unknown) => { if (live) setClipError(String((e as Error)?.message || e)) })
    return () => { live = false }
  }, [clipApi])
  /** 用户要(重新)装的那一下:副本换成随包版本(Chrome 拖进 / 加载已解压时会整份重新加载),返回能用的目录。 */
  const freshClipDir = async (): Promise<string | null> => {
    if (!clipApi || !clipCopy) return null
    if (clipCopy.version === clipCopy.bundled) return clipCopy.dir
    return applyClip(await clipApi.prepare(true).catch((e: unknown) => ({ error: String((e as Error)?.message || e) })))
  }
  const openChrome = async (): Promise<void> => {
    const r = await clipApi?.openChromeExtensions().catch(() => null)
    setOpenNote(r && !r.ok ? t(r.reason === 'no-chrome' ? 'settings.browserExt.noChrome' : 'settings.browserExt.addressCopied') : '')
  }
  const copyPath = async (): Promise<void> => {
    const dir = await freshClipDir()
    if (!dir) return
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
      : info?.connected
        ? (info.clients.at(-1)?.version ? t('settings.browserExt.connectedVersion', { version: info.clients.at(-1)!.version }) : t('settings.browserExt.connected'))
        : info?.lastClient === null ? t('settings.browserExt.notInstalled') : t('settings.browserExt.notConnected') // 从没连上过 = 还没装(或没配对);旧引擎没这个字段 → 按「未连接」

  return (
    <SettingsPanel className="settings-browser-ext-panel" icon={<Puzzle size={16} />} title={t('settings.browserExt.title')} description={t('settings.browserExt.hint')}>
      <div className="settings-control-list" data-testid="browser-extension-panel">
        <SettingsRow label={t('settings.browserExt.status')} control={<span className="hint" data-testid="browser-extension-status">{status}</span>} />
        {!unavailable && info && (
          <SettingsRow
            label={t('settings.browserExt.install')}
            description={(['settings.browserExt.step1', 'settings.browserExt.step2', hostOn ? 'settings.browserExt.step3' : 'settings.browserExt.step3HostOff'] as const).map((k, i) => (
              <React.Fragment key={k}>{i > 0 && <br />}{`${i + 1}. ${t(k)}`}</React.Fragment>
            )).concat(openNote ? [<React.Fragment key="note"><br /><span data-testid="browser-extension-open-note">{openNote}</span></React.Fragment>] : [])
              .concat(clipError ? [<React.Fragment key="err"><br /><span data-testid="browser-extension-copy-error">{t('settings.browserExt.copyFailed', { error: clipError })}</span></React.Fragment>] : [])}
            control={managed ? (
              <div className="settings-inline-actions">
                {clipApi && (
                  <button type="button" className="btn ghost sm" onClick={() => void openChrome()} data-testid="browser-extension-open-chrome">
                    <ExternalLink size={12} />{t('settings.browserExt.openChrome')}
                  </button>
                )}
                {!clipCopy && (
                  <button type="button" className="btn ghost sm" onClick={() => { void window.tangu?.openHostPath?.(info.extensionDir) }}>
                    <FolderOpen size={12} />{t('settings.browserExt.openFolder')}
                  </button>
                )}
              </div>
            ) : undefined}
          />
        )}
        {!unavailable && info && clipApi && clipCopy && (
          <SettingsRow
            label={t('settings.browserExt.folder')}
            description={(
              <>
                <code className="settings-path-text">{clipCopy.dir}</code>
                {clipCopy.version !== clipCopy.bundled && <><br /><span data-testid="browser-extension-update-hint">{t('settings.browserExt.updateHint', { version: clipCopy.bundled })}</span></>}
              </>
            )}
            control={(
              <div className="settings-inline-actions">
                {/* 原生拖出(fs:startDrag):拖进 Chrome 扩展页即「加载已解压」,只在 Chrome 开发者模式下生效 */}
                <div
                  className="settings-drag-chip"
                  draggable
                  title={t('settings.browserExt.dragHint')}
                  data-testid="browser-extension-drag"
                  onDragStart={(e) => {
                    e.preventDefault()
                    if (clipCopy.version === clipCopy.bundled) window.tangu?.startHostDrag?.(clipCopy.dir)
                    else void freshClipDir().then((dir) => { if (dir) window.tangu?.startHostDrag?.(dir) }) // 先换成随包版本再拖(按键还按着,原生拖出照样接得上)
                  }}
                >
                  <GripVertical size={14} className="settings-drag-chip-grip" />
                  <span className="settings-drag-chip-icon"><Puzzle size={14} /></span>
                  <span><b>Forsion Clip</b><small>{t('settings.browserExt.dragSub', { version: clipCopy.version })}</small></span>
                </div>
                <button type="button" className="btn ghost sm" onClick={() => void copyPath()}>{copiedPath ? <Check size={12} /> : <Copy size={12} />}{copiedPath ? t('settings.browserExt.copied') : t('settings.browserExt.copyPath')}</button>
                <button type="button" className="btn ghost sm" onClick={() => { void freshClipDir().then((dir) => { if (dir) void window.tangu?.openHostPath?.(dir) }) }}><FolderOpen size={12} />{t('settings.browserExt.openFolder')}</button>
              </div>
            )}
          />
        )}
        {!unavailable && info && (
          <SettingsRow
            label={t('settings.browserExt.manual')}
            description={t('settings.browserExt.manualHint')}
            control={(
              <button type="button" className="btn ghost sm" aria-expanded={showManual} onClick={() => setManualOpen(!showManual)} data-testid="browser-extension-manual">
                {showManual ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{t(showManual ? 'settings.browserExt.hide' : 'settings.browserExt.show')}
              </button>
            )}
          />
        )}
        {!unavailable && info && showManual && (
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
        {!unavailable && info && !managed && (
          <SettingsRow label={t('settings.browserExt.folder')} description={t('settings.browserExt.remoteDir', { dir: info.extensionDir })} />
        )}
      </div>
    </SettingsPanel>
  )
}
