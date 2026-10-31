// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { printClone } from './printClone'

describe('printClone', () => {
  it('纸面不给悬浮目录留沟,宿主自己的标记不动', () => {
    const host = document.createElement('div')
    host.setAttribute('data-lcl-ftoc', 'left')
    expect(printClone(host).hasAttribute('data-lcl-ftoc')).toBe(false)
    expect(host.getAttribute('data-lcl-ftoc')).toBe('left')
  })
})
