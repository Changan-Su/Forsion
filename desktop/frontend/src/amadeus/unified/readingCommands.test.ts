import { expect, it, vi } from 'vitest'
const active = vi.hoisted(() => ({ scope: 'view-a' }))
vi.mock('../store/pageStore', () => ({ activePageScope: () => active.scope }))
import { registerReadingToggle, READING_COMMANDS } from './readingCommands'
it('an unscoped preview cannot steal or remove the owning note command', () => {
  const note = vi.fn(); const preview = vi.fn(); const other = vi.fn()
  const offNote = registerReadingToggle('view-a', note, true)
  const offPreview = registerReadingToggle('view-a', preview, false)
  const offOther = registerReadingToggle('view-b', other, true)
  READING_COMMANDS[0].run()
  expect(note).toHaveBeenCalledOnce(); expect(preview).not.toHaveBeenCalled()
  offPreview(); READING_COMMANDS[0].run()
  expect(note).toHaveBeenCalledTimes(2)
  active.scope = 'view-b'; READING_COMMANDS[0].run()
  expect(other).toHaveBeenCalledOnce()
  offNote(); offOther()
})
