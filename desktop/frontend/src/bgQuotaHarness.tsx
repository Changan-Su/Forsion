/**
 * Dev-only visual harness:Muse 设置里的「后台额度」区块 —— 真 SpecialAgentsTab + 生产 CSS;引擎端点与账号额度都是桩,
 * 不连任何后端、不碰凭证。?dark / ?lang=en / ?other(Muse 显式选了不计入后台额度的模型)/ ?cloud(云端引擎:只露按轮 Historian 四项)/
 * ?remote(设备页:引擎对远程来源只回开关摘要 + remote:true,P1-K10b —— 只读说明 + 两张开关卡)/
 * ?localbg=<id>(本机「设置 → 模型 → 后台任务」那格选了它:m-direct 自己接的 Key / m-pro 别的 Forsion 模型)。
 * 跑法:node scripts/e2e-editor.cjs --check=bgquota-settings --shot
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { SpecialAgentsTab } from './components/SpecialAgentsTab'
import type { AccountQuotaView } from './services/accountQuota'
import { installEngineHost } from './services/engine/targets'
import type { TanguDesktopConfig } from './types'
import './tangu/store/standalone' // 不走 installEngine:自己装 Tangu 的 store 半身(界面热更新 3c);排在最后,别早于上面那些打桩的 import

const params = new URLSearchParams(location.search)
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', params.has('dark') ? 'dark' : 'light')

const BACKEND = 'http://stub.local'
// 引擎请求经 homeTarget() 取地址(宿主接缝):装一个指向桩的宿主,盖掉 appStore 求值时装的那个(同 channelsHarness)
installEngineHost({ cfg: () => ({ backendUrl: BACKEND, token: 'stub' } as TanguDesktopConfig), desktopConfig: () => ({ mode: 'managed' }) })
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
  if (path === '/agent/special/config') {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'))
      ;(window as unknown as { __bgHarness: { posts: unknown[] } }).__bgHarness.posts.push(body)
      Object.assign(config.historian, body.historian || {})
    }
    if (params.has('remote')) {
      return json({ config: { historian: { enabled: config.historian.enabled, everyRounds: config.historian.everyRounds }, muse: { enabled: false, supervisorPollMinutes: config.muse.supervisorPollMinutes } }, remote: true })
    }
    return json({ config, defaults: { historianPrompt: '' }, ...(params.has('cloud') ? { cloud: true } : {}) })
  }
  if (path === '/agent/models') {
    return json({ models: [{ id: 'm-cheap', name: 'Luna Lite', provider: 'forsion', source: 'forsion' }, { id: 'm-pro', name: 'Opus 5.5', provider: 'forsion', source: 'forsion' },
      { id: 'm-direct', name: 'My Key', provider: 'openai', source: 'direct' }], backgroundModelId: 'm-cheap', defaultModelId: 'm-pro' })
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
  getConfig: async () => ({ backgroundModelId: params.get('localbg') || '' }),
  // 有 Extend 的桌面:剩余量与开关 / 转入都在「Forsion 云端 → 额度与积分」,Muse 页只给跳转(记下跳到哪)
  cloudInvoke: async () => ({}),
  openFloatingPanel: async (req: { params?: { tab?: string } }) => {
    ;(window as unknown as { __bgHarness: { opened: string[] } }).__bgHarness.opened.push(String(req?.params?.tab))
  },
} as unknown as NonNullable<Window['tangu']>
;(window as unknown as { __bgHarness: { opened: string[]; posts: unknown[] } }).__bgHarness = { opened: [], posts: [] }

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <main className="settings-body" style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <SpecialAgentsTab cfg={{ backendUrl: BACKEND, token: 'stub' } as TanguDesktopConfig} />
    </main>
  </LocaleProvider>,
)
