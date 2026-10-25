/**
 * Dev-only visual harness:设置 → 通道 —— 真 ChannelsTab + 生产 CSS,引擎 /agent/channels 是桩。
 * 内置三通道 + 一个插件通道(企业微信,引擎插件 ctx.registerChannel 贡献):卡头名 / 凭据输入 / 提示按插件声明画。
 * ?open(默认展开企业微信卡)/ ?saved(凭据已存:Secret 只显示占位)/ ?connected(已连接)/ ?reject(「连接」返回网关拒绝)/ ?dark / ?lang=en。
 * __channelsHarness.saves 记录 PUT 的补丁。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { ChannelsTab } from './components/ChannelsTab'
import type { TanguDesktopConfig } from './types'
import { installEngineHost } from './services/engine/targets'
import './tangu/store/standalone' // 不走 installEngine:自己装 Tangu 的 store 半身;排在打桩 import 之后

const params = new URLSearchParams(location.search)
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', params.has('dark') ? 'dark' : 'light')

const BACKEND = 'http://stub.local'
installEngineHost({ cfg: () => ({ backendUrl: BACKEND, token: 'stub' } as TanguDesktopConfig), desktopConfig: () => ({ mode: 'managed' }) })

const harness = { saves: [] as unknown[] }
;(window as unknown as { __channelsHarness: typeof harness }).__channelsHarness = harness
const saved = params.has('saved') || params.has('connected')
const base = (kind: string, extra: object = {}) => ({
  kind, enabled: false, sessions: true, agentSlug: '', modelId: '', imageModelId: '', ttsModelId: '', ttsVoice: '',
  approvalMode: 'auto-edit', locale: null, inboxForward: { enabled: false, senders: 'all' },
  credentials: { botTokenSet: false, appIdSet: false, appSecretSet: false, appId: '' },
  runtime: [], connectedSessionId: null, accountId: null, peerBound: false, workspace: `/Users/me/Tangu/${kind}`, ...extra,
})
const wecom = () => base('wecom', {
  enabled: saved,
  credentials: { botTokenSet: false, appIdSet: saved, appSecretSet: saved, appId: saved ? 'aibK3x9QmR2wT7' : '' },
  runtime: saved ? [{ accountId: 'wecom:aibK3x9QmR2wT7', running: params.has('connected'), label: 'aibK3x9QmR2wT7' }] : [],
  connectedSessionId: params.has('connected') ? 's-wecom' : null,
  peerBound: params.has('connected'),
  workspace: '/Users/me/Tangu/wecombot',
  plugin: {
    name: { zh: '企业微信', en: 'WeCom' },
    hint: {
      zh: '企业微信 → 工作台 → 智能机器人 → 创建(API 模式,连接方式选「使用长连接」),把生成的 Bot ID 和 Secret 填到这里。无需公网地址。',
      en: 'In WeCom, go to Workbench → AI bots → Create (API mode, connection: long connection) and paste the generated Bot ID and Secret here. No public URL needed.',
    },
    fields: [
      { key: 'appId', label: { zh: 'Bot ID', en: 'Bot ID' }, secret: false },
      { key: 'appSecret', label: { zh: 'Secret', en: 'Secret' }, secret: true },
    ],
  },
})
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith(BACKEND)) return realFetch(input, init)
  const path = new URL(url).pathname
  if (path === '/agent/channels') {
    return json({ available: true, channels: [base('wechat', { enabled: true }), base('telegram'), base('qq'), wecom()] })
  }
  if (path.endsWith('/config')) { harness.saves.push(JSON.parse(String(init?.body || '{}'))); return json({ ok: true }) }
  if (path === '/agent/channels/wecom/connect') {
    return params.has('reject')
      ? json({ detail: 'WeCom subscribe rejected: invalid bot_id or secret (853000)' }, 500)
      : json({ ok: true, accountId: 'wecom:aibK3x9QmR2wT7', label: 'aibK3x9QmR2wT7', sessionId: 's-wecom' })
  }
  return json({})
}
window.tangu = { backendStatus: async () => ({ status: 'running' }) } as unknown as NonNullable<Window['tangu']>

function Harness() {
  return (
    <main className="settings-body" style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <ChannelsTab cfg={{ backendUrl: BACKEND, token: 'stub' } as TanguDesktopConfig} />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<LocaleProvider><Harness /></LocaleProvider>)
if (!params.has('closed')) {
  // 展开企业微信卡(模拟用户点开卡头)
  const t = window.setInterval(() => {
    const head = [...document.querySelectorAll<HTMLButtonElement>('.chan-head')].find((b) => /企业微信|WeCom/.test(b.textContent || ''))
    if (head) { window.clearInterval(t); head.click() }
  }, 100)
}
