import { registerMessages, translate } from '@/i18n'

registerMessages({
  'unit.bootError.title': { zh: '暂时无法打开此 Unit', en: 'Unable to open this Unit' },
  'unit.bootError.detail': { zh: '请检查连接后重试。', en: 'Check your connection and try again.' },
  'unit.bootError.retry': { zh: '重试', en: 'Try again' },
})

/** Bootstrap failures must leave a usable page before the full renderer exists. */
export function showUnitBootError(): void {
  const root = document.getElementById('root') ?? document.body.appendChild(document.createElement('main'))
  const panel = document.createElement('section')
  panel.setAttribute('role', 'alert')
  const dark = document.documentElement.dataset.mode === 'dark'
  panel.style.cssText = 'max-width:440px;margin:15vh auto;padding:24px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
  panel.style.color = `var(--text,${dark ? '#f2efe8' : '#1c1c1c'})`
  panel.style.colorScheme = dark ? 'dark' : 'light'
  const title = document.createElement('h1')
  title.textContent = translate('unit.bootError.title')
  title.style.cssText = 'font-size:20px;font-weight:600;margin:0 0 8px'
  const detail = document.createElement('p')
  detail.textContent = translate('unit.bootError.detail')
  detail.style.cssText = 'margin:0 0 20px;color:var(--text-muted,inherit)'
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = translate('unit.bootError.retry')
  retry.style.cssText = 'font:inherit;padding:7px 16px;cursor:pointer'
  retry.addEventListener('click', () => location.reload())
  panel.append(title, detail, retry)
  root.replaceChildren(panel)
  retry.focus()
}
