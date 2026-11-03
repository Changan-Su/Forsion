// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

it('renders a custom fallback and remounts children on reset (onboarding step boundary, walkthrough 6.19)', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true
  const Step = () => { if (broken) throw new Error('boom'); return React.createElement('p', null, 'step ok') }
  const host = document.createElement('div'); const root = createRoot(host)
  await act(async () => root.render(React.createElement('div', null, React.createElement('nav', null, 'rail'),
    React.createElement(ErrorBoundary, { fallback: (error, reset) => React.createElement('button', { onClick: reset }, `failed: ${error.message}`), children: React.createElement(Step) }))))
  expect(host.textContent).toBe('railfailed: boom')
  broken = false
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toBe('railstep ok')
  await act(async () => root.unmount())
})
