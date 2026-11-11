import { describe, it, expect, vi } from 'vitest'
import { createExtendViewController } from '@lcl/engine/extendView'
import { scopeFileExtension } from './fileExtension'

describe('file extension lifecycle', () => {
  it('reuses a panel and revokes retained controllers on file navigation/disable', () => {
    const owner = createExtendViewController(), file = scopeFileExtension(owner.controller)
    const onClose = vi.fn(), mount = vi.fn()
    const first = file.controller.open({ id: 'chat', title: 'Chat', mount, onClose })
    expect(file.controller.open({ id: 'chat', title: 'Chat', mount })).toBe(first)
    file.dispose()
    expect(first.isOpen).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
    expect(() => file.controller.open({ id: 'late', title: 'Late', mount })).toThrow('closed')
    const next = owner.controller.open({ id: 'next-file', title: 'Next', mount })
    file.controller.close(); first.close(); file.dispose()
    expect(next.isOpen).toBe(true)
  })
})
