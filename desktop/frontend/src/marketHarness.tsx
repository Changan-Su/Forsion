import './marketHarnessBridge'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './theme/skins.css'
import './theme/themes/lovable/theme.css'
import { LocaleProvider } from './i18n'
import './i18n.generated'
import { MarketModal } from './components/MarketModal'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import './tangu/store/standalone' // 不走 installEngine:自己装 Tangu 的 store 半身(界面热更新 3c);排在最后,别早于上面那些打桩的 import

// 台架检查用:往插件 store 里塞「插件提供的商店页」(ctx.registerStoreView 写的就是这块)。
;(window as unknown as { __marketHarness: unknown }).__marketHarness = { pluginStore: usePluginStore }

document.body.style.margin = '0'
document.body.style.height = '100vh'
document.getElementById('root')!.style.height = '100%'

createRoot(document.getElementById('root')!).render(
  <LocaleProvider><MarketModal /></LocaleProvider>,
)
