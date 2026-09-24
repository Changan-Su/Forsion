/**
 * Dev-only visual harness:Muse 设置里的「后台额度」区块 —— 真 SpecialAgentsTab + 生产 CSS;引擎端点与账号额度都是桩,
 * 不连任何后端、不碰凭证。?dark / ?lang=en / ?other(Muse 显式选了不计入后台额度的模型)。
 * 跑法:node scripts/e2e-editor.cjs --check=bgquota-settings --shot
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { SpecialAgentsTab } from './components/SpecialAgentsTab'
import type { AccountQuotaView } from './services/accountQuota'
import type { TanguDesktopConfig } from './types'

const params = new URLSearchParams(location.search)
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', params.has('dark') ? 'dark' : 'light')

const BACKEND = 'http://stub.local'
const config = {
  historian: { enabled: true, modelId: '', everyRounds: 5, firstRoundTrigger: true, mode: 'independent', prompt: '', harnessCandidates: false },
  muse: {
    enabled: true, modelId: params.has('other') ? 'm-pro' : '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20,
    maxTodosPerWindow: 5, supervisorPollMinutes: 5, activeHours: null, allowedFolders: [], mode: 'ask', heartbeatMinutes: 120, notify: 'immediate', escalateTo: '',
  },
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith(BACKEND)) return realFetch(input, init)
  const path = new URL(url).pathname
  if (path === '/agent/special/config') return json({ config, defaults: { historianPrompt: '' } })
  if (path === '/agent/models') {
    return json({ models: [{ id: 'm-cheap', name: 'Luna Lite', provider: 'forsion' }, { id: 'm-pro', name: 'Opus 5.5', provider: 'forsion' }], backgroundModelId: 'm-cheap', defaultModelId: 'm-pro' })
  }
  if (path === '/agent/agents') return json({ agents: [] })
  return json({})
}

let quota: AccountQuotaView = {
  dailyLimit: 100, dailyRemaining: 70, weeklyLimit: 500, weeklyRemaining: 400,
  background: {
    sharePercent: 15, modelId: 'm-cheap', autoMain: false,
    dailyLimit: 15, dailyUsed: 13, dailyRemaining: 2, dailyPercent: 87,
    weeklyLimit: 75, weeklyUsed: 30, weeklyRemaining: 45, weeklyPercent: 40,
  },
}
window.tangu = {
  accountQuota: async () => ({ status: 200, json: quota }),
  accountBgAutoMain: async (enabled: boolean) => {
    quota = { ...quota, background: { ...quota.background!, autoMain: enabled } }
    return { status: 200, json: { success: true, autoMain: enabled } }
  },
  accountBgConvert: async (percent: number) => {
    const bg = quota.background!
    const d = (100 * percent) / 100, w = (500 * percent) / 100
    quota = {
      ...quota, dailyRemaining: (quota.dailyRemaining || 0) - d, weeklyRemaining: (quota.weeklyRemaining || 0) - w,
      background: { ...bg, dailyLimit: bg.dailyLimit + d, dailyRemaining: (bg.dailyRemaining || 0) + d, weeklyLimit: bg.weeklyLimit + w, weeklyRemaining: (bg.weeklyRemaining || 0) + w },
    }
    ;(window as unknown as { __bgHarness: { converted: number[] } }).__bgHarness.converted.push(percent)
    return { status: 200, json: { success: true, converted: { daily: d, weekly: w }, quota } }
  },
} as unknown as NonNullable<Window['tangu']>
;(window as unknown as { __bgHarness: { converted: number[] } }).__bgHarness = { converted: [] }

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <main className="settings-body" style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <SpecialAgentsTab cfg={{ backendUrl: BACKEND, token: 'stub' } as TanguDesktopConfig} />
    </main>
  </LocaleProvider>,
)
