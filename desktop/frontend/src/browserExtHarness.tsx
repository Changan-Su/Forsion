/**
 * Dev-only visual harness:设置 → 浏览器 →「Chrome 扩展」卡片 —— 真 BrowserExtensionPanel + 生产 CSS;
 * 引擎端点与 openHostPath 都是桩,不连后端。?connected / ?busy(端口被占)/ ?external(外部引擎)/ ?dark / ?lang=en;
 * __extHarness.holdPolls=true 扣住之后的状态轮询(按发出时刻的状态作答),release() 放行 —— 复现「旧轮询晚到」竞态。
 * 跑法:node scripts/e2e-editor.cjs --check=browserext-settings --shot
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { BrowserExtensionPanel } from './components/BrowserExtensionPanel'
import type { TanguDesktopConfig } from './types'

const params = new URLSearchParams(location.search)
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', params.has('dark') ? 'dark' : 'light')

const BACKEND = 'http://stub.local'
const harness = {
  opened: [] as string[], resets: 0, code: 'tangu:47655:3f9c2a71d04b8e56a1c7f02d9e4b6a8c13e5f7092b4d6c8e',
  holdPolls: false, held: [] as Array<() => void>,
  release() { harness.holdPolls = false; for (const r of harness.held.splice(0)) r() },
}
;(window as unknown as { __extHarness: typeof harness }).__extHarness = harness
const status = () => ({
  enabled: true, port: 47655, listening: !params.has('busy'), error: params.has('busy') ? 'EADDRINUSE' : '',
  connected: params.has('connected'), clients: params.has('connected') ? [{ version: '0.1.0', connectedAt: Date.now() }] : [],
  extensionId: 'gpajikakdmhjebadgcbmhidkkajclfoi', extensionDir: '/Applications/Forsion.app/Contents/Resources/tangu-server/browser-extension', code: harness.code,
})
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith(BACKEND)) return realFetch(input, init)
  const path = new URL(url).pathname
  if (path === '/agent/browser-extension/reset-code') { harness.resets++; harness.code = `tangu:47655:${'ab'.repeat(24)}`; return json(status()) }
  if (path === '/agent/browser-extension') {
    const snap = status() // 请求发出那一刻的状态(含当时的码)
    if (harness.holdPolls) await new Promise<void>((r) => harness.held.push(r))
    return json(snap)
  }
  return json({})
}
window.tangu = {
  openHostPath: async (p: string) => { harness.opened.push(p); return { ok: true } },
} as unknown as NonNullable<Window['tangu']>

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <main className="settings-body" style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <BrowserExtensionPanel cfg={{ backendUrl: BACKEND, token: 'stub' } as TanguDesktopConfig} managed={!params.has('external')} />
    </main>
  </LocaleProvider>,
)
