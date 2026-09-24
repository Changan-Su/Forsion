/** Dev-only visual harness for the real quota advisory component and Chatbox surfaces. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUp, Plus } from 'lucide-react'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import './views/chat2/chat2.css'
import './views/chat2/composer2.css'
import './quotaHarness.css'
import { applyTheme } from './theme/loader'
import { QuotaAdvisoryBanner } from './components/QuotaAdvisoryBanner'
import { publishAccountQuota, type AccountQuotaView } from './services/accountQuota'

setLocaleGlobal('zh')
const themeParams = new URLSearchParams(location.search)
const dark = themeParams.has('dark')
applyTheme(themeParams.get('theme') || 'lovable', themeParams.get('skin') || 'cream', themeParams.get('bg') || 'cream', dark ? 'dark' : 'light')

let quota: AccountQuotaView = {
  dailyLimit: 100,
  dailyRemaining: 62,
  weeklyLimit: 100,
  weeklyRemaining: 8,
  resetCards: 2,
}

window.tangu = {
  // museAvailable() 看它:有本地引擎才会出后台额度那条(Muse 只在桌面本地跑)
  backendStatus: async () => ({ state: 'running' }),
  accountQuota: async () => ({ status: 200, json: quota }),
  accountBgConvert: async (percent: number) => {
    const bg = quota.background
    if (bg) {
      const add = percent // 台架主限额恒 100:转入 限额×percent% = percent 点
      quota = { ...quota, background: { ...bg, dailyLimit: bg.dailyLimit + add, dailyRemaining: (bg.dailyRemaining || 0) + add, weeklyLimit: bg.weeklyLimit + add, weeklyRemaining: (bg.weeklyRemaining || 0) + add } }
    }
    return { status: 200, json: { success: true, quota } }
  },
  accountUseResetCard: async () => {
    quota = { ...quota, dailyRemaining: 100, weeklyRemaining: 100, resetCards: Math.max(0, (quota.resetCards || 0) - 1) }
    return { status: 200, json: { success: true, quota, resetCards: quota.resetCards } }
  },
  openPayCenter: async () => {
    ;(window as unknown as { __quotaHarness: { upgraded: boolean } }).__quotaHarness.upgraded = true
    return { ok: true }
  },
} as NonNullable<Window['tangu']>

;(window as unknown as { __quotaHarness: {
  upgraded: boolean
  setQuota(patch: Partial<AccountQuotaView>): void
} }).__quotaHarness = {
  upgraded: false,
  setQuota(patch) {
    quota = { ...quota, ...patch }
    publishAccountQuota(quota)
  },
}

function Harness() {
  const [toast, setToast] = useState('')
  return (
    <LocaleProvider>
      <main className="quota-harness-stage">
        <section className="t2-chat-view quota-harness-chat">
          <div className="t2-chat-col">
            <div className="quota-harness-conversation">
              <div className="quota-harness-bubble">帮我整理这份项目计划，并列出下一步。</div>
              <p>我会先读取项目背景，再给出一份清晰的执行清单。</p>
            </div>
            <div className="composer-anchor">
              <div className="t2c">
                <div className="t2c-inner">
                  <div className="t2c-card">
                    <QuotaAdvisoryBanner loggedIn onToast={(text) => setToast(text)} />
                    <textarea className="t2c-ta" aria-label="消息" placeholder="给 Tangu 发消息…" />
                    <div className="t2c-row">
                      <button className="t2c-iconbtn" aria-label="添加"><Plus size={15} /></button>
                      <span className="t2c-grow" />
                      <span className="quota-harness-model">GPT-5.6</span>
                      <button className="t2c-send" aria-label="发送"><ArrowUp size={16} /></button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        {toast && <div className="quota-harness-toast" role="status">{toast}</div>}
      </main>
    </LocaleProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
