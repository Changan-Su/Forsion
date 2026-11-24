import './marketHarnessBridge'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './theme/skins.css'
import './theme/themes/lovable/theme.css'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import { MarketModal } from './components/MarketModal'
import { AmadeusPluginsTab } from './components/AmadeusPluginsTab'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { setTanguProbe } from '@amadeus/plugins/tanguSeam'
import { noteHostDenial } from '@amadeus/plugins/hostDenials'
import './tangu/store/standalone' // 不走 installEngine:自己装 Tangu 的 store 半身(界面热更新 3c);排在最后,别早于上面那些打桩的 import

// 台架检查用:往插件 store 里塞「插件提供的商店页」(ctx.registerStoreView 写的就是这块)。
;(window as unknown as { __marketHarness: unknown }).__marketHarness = { pluginStore: usePluginStore }

document.body.style.margin = '0'
document.body.style.height = '100vh'
document.getElementById('root')!.style.height = '100%'

const q = new URLSearchParams(location.search)
// ?plugin-detail:插件详情页,外部引擎模式下带引擎半身的插件 + 一条被宿主拒掉的请求(11-23,看注明与记录的观感)
if (q.has('plugin-detail')) {
  setLocaleGlobal(q.get('lang') === 'en' ? 'en' : 'zh')
  setTanguProbe({ activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {}, hostExecution: () => false, hostExecutionBlock: () => 'external-engine' } as never)
  // 详情页挂上时会兜底装载一遍插件(把 store 换成空的),等它装完再塞
  setTimeout(() => {
    usePluginStore.setState({ plugins: [{ id: 'reading-log', name: 'Reading log', version: '0.3.1', description: 'Track the books you read.', bundle: { dir: 'reading-log', enginePlugins: ['reading-log-engine'], agents: [], skills: [], spaces: [] } } as never], activeIds: ['reading-log'], disabledIds: [] } as never)
    noteHostDenial('reading-log', 'ctx.tangu.request', 'external-engine')
  }, 1500)
}

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>{q.has('plugin-detail')
    ? <div className="settings-body" style={{ maxWidth: 640, padding: 24 }}><AmadeusPluginsTab controlledDetail={{ id: 'reading-log', onBack: () => {} }} /></div>
    : <MarketModal />}</LocaleProvider>,
)
