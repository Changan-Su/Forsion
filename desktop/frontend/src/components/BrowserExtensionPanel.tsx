import React, { useCallback, useEffect, useState } from 'react'
import { Check, Copy, FolderOpen, Puzzle, RefreshCw } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getBrowserExtension, resetBrowserExtensionCode, type BrowserExtensionStatus } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'

registerMessages({
  'settings.browserExt.title': { zh: 'Chrome 扩展（Tangu for Chrome）', en: 'Chrome extension (Tangu for Chrome)' },
  'settings.browserExt.hint': {
    zh: '装上后，Tangu 能看到你打开的标签页和你正在看的那一个，并在自己的「Tangu」标签组里后台操作，不占用你正在看的页面，也不会再弹「允许远程调试」。',
    en: 'Once installed, Tangu can see your open tabs and the one you are looking at, and works in its own “Tangu” tab group in the background, without taking over your page or asking to allow remote debugging.',
  },
  'settings.browserExt.status': { zh: '状态', en: 'Status' },
  'settings.browserExt.connected': { zh: '已连接', en: 'Connected' },
  'settings.browserExt.notConnected': { zh: '未连接', en: 'Not connected' },
  'settings.browserExt.portBusy': { zh: '端口 {port} 不可用：{error}', en: 'Port {port} is unavailable: {error}' },
  'settings.browserExt.unavailable': { zh: '当前引擎不支持 Chrome 扩展（需要本机引擎）。', en: 'The current engine does not support the Chrome extension (a local engine is required).' },
  'settings.browserExt.code': { zh: '连接码', en: 'Connect code' },
  'settings.browserExt.codeHint': { zh: '粘贴到扩展弹窗里即可配对，只需要一次。', en: 'Paste it into the extension popup to pair. You only need to do this once.' },
  'settings.browserExt.copy': { zh: '复制', en: 'Copy' },
  'settings.browserExt.copied': { zh: '已复制', en: 'Copied' },
  'settings.browserExt.reset': { zh: '换一个', en: 'New code' },
  'settings.browserExt.resetConfirm': { zh: '换码后，已配对的扩展会断开，需要重新粘贴。继续吗？', en: 'Paired extensions will disconnect and need the new code. Continue?' },
  'settings.browserExt.install': { zh: '安装步骤', en: 'How to install' },
  'settings.browserExt.step1': { zh: '在 Chrome 地址栏打开 chrome://extensions，打开右上角的「开发者模式」。', en: 'In Chrome, open chrome://extensions and turn on Developer mode (top right).' },
  'settings.browserExt.step2': { zh: '点「加载已解压的扩展程序」，选择扩展文件夹。', en: 'Click “Load unpacked” and choose the extension folder.' },
  'settings.browserExt.step3': { zh: '点工具栏里的 Tangu 图标，粘贴上面的连接码。', en: 'Click the Tangu icon in the toolbar and paste the connect code above.' },
  'settings.browserExt.openFolder': { zh: '打开扩展文件夹', en: 'Open extension folder' },
})

/** 设置 → 浏览器:Tangu for Chrome 扩展的状态、连接码与安装步骤(连接状态 3 秒刷新一次)。 */
export function BrowserExtensionPanel({ cfg }: { cfg: TanguDesktopConfig }): React.ReactElement {
  const { t } = useI18n()
  const [info, setInfo] = useState<BrowserExtensionStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try { setInfo(await getBrowserExtension(cfg)); setUnavailable(false) } catch { setUnavailable(true) }
  }, [cfg])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 3000)
    return () => window.clearInterval(timer)
  }, [load])

  const copy = async (): Promise<void> => {
    if (!info?.code) return
    try { await navigator.clipboard.writeText(info.code); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { /* 剪贴板不可用时用户仍可手选 */ }
  }
  const reset = async (): Promise<void> => {
    if (!window.confirm(t('settings.browserExt.resetConfirm'))) return
    try { setInfo(await resetBrowserExtensionCode(cfg)) } catch { /* 下次轮询会刷新 */ }
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
                <button type="button" className="btn ghost sm" onClick={() => void reset()}><RefreshCw size={12} />{t('settings.browserExt.reset')}</button>
              </div>
            )}
          />
        )}
        {!unavailable && info && (
          <SettingsRow
            label={t('settings.browserExt.install')}
            description={(['settings.browserExt.step1', 'settings.browserExt.step2', 'settings.browserExt.step3'] as const).map((k, i) => (
              <React.Fragment key={k}>{i > 0 && <br />}{`${i + 1}. ${t(k)}`}</React.Fragment>
            ))}
            control={(
              <button type="button" className="btn ghost sm" onClick={() => { void window.tangu?.openHostPath?.(info.extensionDir) }}>
                <FolderOpen size={12} />{t('settings.browserExt.openFolder')}
              </button>
            )}
          />
        )}
      </div>
    </SettingsPanel>
  )
}
