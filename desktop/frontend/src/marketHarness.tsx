import './marketHarnessBridge'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './theme/skins.css'
import './theme/themes/lovable/theme.css'
import { LocaleProvider } from './i18n'
import './i18n.generated'
import { MarketModal } from './components/MarketModal'

document.body.style.margin = '0'
document.body.style.height = '100vh'
document.getElementById('root')!.style.height = '100%'

createRoot(document.getElementById('root')!).render(
  <LocaleProvider><MarketModal /></LocaleProvider>,
)
