// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { usePluginStore } from './pluginStore'
import { currentNoteRenderer } from './noteRenderers'
import type { PluginContext } from './types'
it('revoked setup cannot overwrite a replacement through the real plugin context', () => {
  const id = 'reading-lifecycle-probe'
  const contexts: PluginContext[] = []
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const contribution = { id: 'reader', apiVersion: 1 as const, mount() {} }
  usePluginStore.getState().init([{ id, name: 'Reader', version: '1', setup(ctx) { contexts.push(ctx); ctx.registerNoteRenderer!(contribution) } }])
  usePluginStore.getState().toggle(id)
  usePluginStore.getState().toggle(id)
  const current = currentNoteRenderer()
  expect(current?.pluginId).toBe(id)
  contexts[0].registerNoteRenderer!(contribution)
  expect(currentNoteRenderer()).toBe(current)
  usePluginStore.getState().toggle(id)
  expect(currentNoteRenderer()).toBeNull()
  log.mockRestore()
})
