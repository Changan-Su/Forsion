/**
 * Dev-only 台架:输入框上下文环的详情弹层(真 ContextUsagePop + 真 composer2.css)。
 * 参数:?lang=en  ?dark  ?theme=genesis-glass  ?noinfo(还没跑过 run)  ?logout(未登录)  ?unlimited(今日不限)  ?capped(1M 被封顶)
 *      ?over(占用超出窗口);window.__ctxu.switchAccount() = 直接换到账号 B(B 的额度 300ms 后才回来)
 * 跑:node scripts/e2e-editor.cjs --check=ctxusage --shot
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import './views/chat2/chat2.css'
import './views/chat2/composer2.css'
import { applyTheme } from './theme/loader'
import { ContextUsagePop } from './views/chat2/ContextUsagePop'
import { useApp } from './stores/appStore'
import type { AuthStatusInfo, CtxInfo } from './types'

const q = new URLSearchParams(location.search)
setLocaleGlobal(q.get('lang') === 'en' ? 'en' : 'zh')
applyTheme(q.get('theme') || 'lovable', 'cream', 'cream', q.has('dark') ? 'dark' : 'light')

const quota = {
  dailyLimit: q.has('unlimited') ? -1 : 100, dailyRemaining: q.has('unlimited') ? -1 : 88, dailyPercent: 12,
  weeklyLimit: 500, weeklyRemaining: 40, weeklyPercent: 92, weeklyResetAt: '2026-10-02',
}
let account = 'A'
const quotaB = { ...quota, dailyRemaining: 50, dailyPercent: 50, weeklyRemaining: 450, weeklyPercent: 10 }
window.tangu = {
  accountQuota: async () => account === 'A' ? { status: 200, json: quota } : new Promise((r) => setTimeout(() => r({ status: 200, json: quotaB }), 300)),
} as unknown as NonNullable<Window['tangu']>
const signIn = (id: string) => useApp.setState({ authInfo: { accountId: id, loggedIn: true, tokenValid: true, membershipTier: 'pro', cloudUrl: '', username: `demo-${id}`, tokenSource: 'tangu-login' } as AuthStatusInfo })
if (!q.has('logout')) signIn('A')
;(window as unknown as { __ctxu: { switchAccount(): void } }).__ctxu = { switchAccount() { account = 'B'; signIn('B') } }

const info: CtxInfo = {
  ctxWindow: 272000,
  ctxWindowSource: 'family',
  ...(q.has('capped') ? { ctxWindowMax: 1000000 } : {}),
  sections: [
    { k: 'persona', tokens: 2100 }, { k: 'guidance', tokens: 5400 }, { k: 'environment', tokens: 3800 },
    { k: 'memory', tokens: 2600 }, { k: 'profile', tokens: 900 }, { k: 'project', tokens: 3100 },
    { k: 'skills', tokens: 4200 }, { k: 'hooks', tokens: 300 },
  ],
  files: ['/Users/demo/app/AGENTS.md', '/Users/demo/app/docs/CLAUDE.md'],
  filesTruncated: false,
  historyCount: 38,
  historyTokens: 61000,
  compactAt: 255616,
}
;(window as unknown as { __compacted: number }).__compacted = 0

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <main style={{ minHeight: '100vh', background: 'var(--bg)', position: 'relative' }}>
      <span className="t2c-ctxring is-open" data-cmenu style={{ position: 'absolute', left: 40, bottom: 40 }}>
        <button type="button" className="t2c-ctxring-btn" aria-label="ctx">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle className="t2c-ctxring-track" cx="12" cy="12" r="9" />
            <circle className="t2c-ctxring-fill" cx="12" cy="12" r="9" style={{ strokeDasharray: 56.5, strokeDashoffset: 32 }} />
          </svg>
        </button>
        <span className="t2c-ctxring-pop">
          <ContextUsagePop
            open
            contextWindow={272000}
            ctxTokens={q.has('over') ? 300000 : 117600}
            sessionTokens={402000}
            ctxInfo={q.has('noinfo') ? null : info}
            onCompact={() => { (window as unknown as { __compacted: number }).__compacted++ }}
          />
        </span>
      </span>
    </main>
  </LocaleProvider>,
)
