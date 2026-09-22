// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { saveModelPickerPreferences } from '../modelPickerPreferences'
import { OnboardingModelChoice } from './OnboardingModelChoice'
import './onboardingMessages'
import type { ModelsResponse } from '../types'

let host: HTMLDivElement, root: Root
const onChange = vi.fn()
const catalog: ModelsResponse = {
  defaultModelId: 'cloud-0', directProviders: [],
  models: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `cloud-${i}`, name: `Chat ${i}`, provider: 'Cloud provider', source: 'forsion' as const, groupId: 'cloud', groupName: 'Cloud group' })),
    { id: 'direct', name: 'Local chat', provider: 'Local provider', source: 'direct' },
    { id: 'hidden', name: 'Hidden chat', provider: 'Local provider', source: 'direct' },
    { id: 'image', name: 'Image only', provider: 'Images', source: 'forsion', modelType: 'image_gen' },
    { id: 'asr', name: 'Speech only', provider: 'Speech', source: 'direct', modelType: 'asr' },
  ],
}
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  onChange.mockClear()
  saveModelPickerPreferences({ groups: [{ id: 'mine', name: 'My group' }], assignments: { direct: 'mine' }, hidden: ['hidden'] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function render(value = '') {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(OnboardingModelChoice, { models: catalog, value, onChange }) })))
}
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()) }
it('shows cloud and custom local groups, hides non-chat/hidden models and paginates the catalog', async () => {
  await render()
  expect(host.querySelectorAll('.ob-model-groups button')).toHaveLength(3)
  expect(host.querySelector('.ob-model-groups')?.textContent).toContain('My group')
  expect(host.querySelectorAll('.ob-model-option')).toHaveLength(6)
  await click('.ob-model-pagination button:last-child')
  expect(host.querySelectorAll('.ob-model-option')).toHaveLength(3)
  expect(host.textContent).not.toMatch(/Image only|Speech only|Hidden chat/)
  await click('.ob-model-groups button:last-child')
  expect(host.querySelectorAll('.ob-model-option')).toHaveLength(1)
  await click('.ob-model-option')
  expect(onChange).toHaveBeenLastCalledWith('direct')
})
it('searches groups and preserves the selected model outside search results; follow default clears overrides', async () => {
  await render('direct')
  const input = host.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Cloud group')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.querySelector('.ob-model-grid')?.textContent).not.toContain('Local chat')
  expect(host.querySelector('.ob-model-selection')?.textContent).toContain('Local chat')
  await click('.ob-model-default')
  expect(onChange).toHaveBeenLastCalledWith('')
})
