// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('../stores/themeStore', () => ({ useVisualTheme: (select: any) => select({ mode: 'light' }) }))
vi.mock('@amadeus/store/pageStore', () => ({ usePageStore: Object.assign((select: any) => select({ vaultRoot: '/vault' }), { getState: () => ({ vaultRoot: '/vault' }) }) }))
vi.mock('./vaultRelParam', () => ({ useVaultRelParam: (leaf: any, key: string) => leaf.params[key] }))

it('image actual size survives a Space-style unmount/remount', async () => {
  const { AmadeusImageView } = await import('./AmadeusImageView')
  const leaf = { id: 'image', params: { imagePath: 'test.png' }, setTitle: vi.fn() }
  const host = document.createElement('div'); document.body.append(host)
  let root = createRoot(host)
  await act(async () => root.render(createElement(AmadeusImageView, { leaf } as any)))
  await act(async () => host.querySelector('img')!.click())
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => root.render(createElement(AmadeusImageView, { leaf } as any)))
  try { expect(host.querySelector('.amx-imgview-scroll')!.classList.contains('actual')).toBe(true) }
  finally { await act(async () => root.unmount()); host.remove() }
})
