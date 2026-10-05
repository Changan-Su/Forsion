import './marketHarnessBridge'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './theme/skins.css'
import './theme/themes/lovable/theme.css'
import { LocaleProvider } from './i18n'
import './i18n.generated'
import { MarketModal } from './components/MarketModal'
import { usePluginStore } from '@amadeus/plugins/pluginStore'

// 台架检查用:往插件 store 里塞「插件提供的商店页」(ctx.registerStoreView 写的就是这块)。
;(window as unknown as { __marketHarness: unknown }).__marketHarness = { pluginStore: usePluginStore }

document.body.style.margin = '0'
document.body.style.height = '100vh'
document.getElementById('root')!.style.height = '100%'

createRoot(document.getElementById('root')!).render(
  <LocaleProvider><MarketModal /></LocaleProvider>,
)
