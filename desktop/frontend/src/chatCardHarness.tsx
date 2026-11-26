// 对话里的商店卡片台架(真 MarketPluginCards + 真样式):数据走 market-harness 的桌面桥,不读账号、网络或用户目录。
// 卡片结果按契约 §3.3 带 publisher / origin / downloads / requirements(老引擎会剥掉它们,卡片照样从 id 认出来源)。
import './marketHarnessBridge'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './theme/skins.css'
import './theme/themes/lovable/theme.css'
import { LocaleProvider } from './i18n'
import './i18n.generated'
import { MarketPluginCards } from './components/MarketPluginCards'
import { auditWarns, type CollectedInfo } from '../../shared/storeSources'
import './tangu/store/standalone'

const tangu = (window as unknown as { tangu: { marketList(): Promise<{ items: Array<Record<string, unknown>> }>; marketSourcesItem(id: string): Promise<Record<string, unknown>> } }).tangu
const ev = (id: string, items: unknown[]) => ({ id, name: 'recommend_marketplace_plugin', done: true, isError: false, args: {}, result: JSON.stringify({ kind: 'marketplace', version: 1, items }) })
const forsion = (r: Record<string, unknown>) => ({ ...r, origin: { kind: 'forsion', publisher: r.publisher ?? 'developer' } })
const collected = (r: Record<string, unknown>) => {
  const c = r.collected as CollectedInfo | undefined
  const o = r.origin as { sourceId: string; sourceTitle: string }
  const { collected: _c, prereqs: _p, commit: _m, ...rest } = r
  return { ...rest, origin: { kind: o.sourceId === '25aae625' ? 'collected' : 'source', ...o }, ...(c ? { requirements: { ...c.requirements, scripts: c.scripts, auditWarn: auditWarns(c) } } : {}) }
}

void (async () => {
  const list = (await tangu.marketList()).items
  const pick = (id: string) => forsion(list.find((r) => r.id === id)!)
  const src = async (id: string) => collected(await tangu.marketSourcesItem(id))
  const first = [pick('source-check'), await src('src_25aae625_frontend-design')]
  const second = [await src('src_25aae625_framecraft'), await src('src_25aae625_trailmap'), await src('src_0a1b2c3d_poster')]
  document.body.style.margin = '0'
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 24px' }} data-chatcard-harness>
        <MarketPluginCards event={ev('e1', first) as never} />
        <MarketPluginCards event={ev('e2', second) as never} />
      </div>
    </LocaleProvider>,
  )
})()
