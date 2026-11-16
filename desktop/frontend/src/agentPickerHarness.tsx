/** Real AgentSelectStrip / CompactChatPicker with isolated roster fixtures; no engine or user data. */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import './views/chat2/composer2.css'
import './tangu/store/standalone'
import { AgentSelectStrip } from './components/AgentSelectStrip'
import { useApp } from './stores/appStore'
import { applyTheme } from './theme/loader'
import type { NormalAgentDef } from './types'

const query = new URLSearchParams(location.search)
setLocaleGlobal(query.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', query.has('light') ? 'light' : 'dark')
document.body.style.zoom = query.get('zoom') || '1'
const customDescription = '用户编写的说明 / User-authored description'
const agents = [
  { slug: 'xyra', name: 'Amia', nameZh: '阿米娅', nameEn: 'Amia', description: 'General assistant' },
  { slug: 'aria', name: 'Aria', nameZh: '特蕾西娅', nameEn: 'Aria', description: customDescription },
  { slug: 'recita', name: 'Recita', nameZh: '可露希尔', nameEn: 'Recita', description: 'Short description' },
  { slug: 'coding', name: 'Logos', nameZh: '逻各斯', nameEn: 'Logos', description: 'Build and refine working web apps with a project brief, live preview, Forsion AI, and verified repairs' },
  { slug: 'muse', name: 'Kaltsit', nameZh: '凯尔希', nameEn: 'Kaltsit', description: '后台执行官：持续观察你的活动，主动发现值得做的事（经 Muse TODO 提交）' },
  { slug: 'listener', name: 'Listener', nameZh: '谛听', nameEn: 'Listener', description: '' },
  { slug: 'long', name: 'Long description', nameZh: '长说明', nameEn: 'Long description', description: 'Long custom description. '.repeat(35) + 'x'.repeat(200) },
  ...Array.from({ length: 12 }, (_, i) => ({ slug: `extra-${i}`, name: `Extra ${i}`, description: `Extra description ${i}` })),
] as NormalAgentDef[]
useApp.setState({ agentDefs: agents, defaultAgentSlug: 'xyra', engines: [], teams: [] })
Object.assign(window, { __agentPicker: { setLocale: setLocaleGlobal, customDescription } })

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <div style={{ position: 'fixed', left: 48, bottom: 30 }}>
      <AgentSelectStrip sessionId="picker-fixture" cfg={{ execMode: 'sandbox' }} />
    </div>
  </LocaleProvider>,
)
