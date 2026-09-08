// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { setLocaleGlobal } from '../i18n'
import { showUnitBootError } from '../../../../web/src/unitBootError'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; setLocaleGlobal('zh') })

it.each([
  ['zh', '暂时无法打开此 Unit', '重试'],
  ['en', 'Unable to open this Unit', 'Try again'],
] as const)('renders a retryable, localized bootstrap error in %s', (locale, title, label) => {
  setLocaleGlobal(locale)
  document.body.innerHTML = '<div id="root">An old private panel</div>'
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  showUnitBootError()
  expect(document.querySelector('[role="alert"] h1')?.textContent).toBe(title)
  expect(document.body.textContent).not.toContain('old private')
  const button = document.querySelector('button')!
  expect(button.textContent).toBe(label)
  expect(document.activeElement).toBe(button)
  button.click()
  expect(reload).toHaveBeenCalledOnce()
})
