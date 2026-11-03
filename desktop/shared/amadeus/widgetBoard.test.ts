import { describe, expect, it } from 'vitest'
import { addWidgetToBoard, moveWidgetOnBoard, parseWidgetRef, readBoardWidgets, removeWidgetFromBoard, setWidgetScope, widgetRefSource } from './widgetBoard'
import { parseWidget } from './dashboard'
import { readDash3Layout } from './dashboard3'
import { extractFrontmatterExtra } from './compiler/split'

const P = 'Dashboards/卡片区.dashboard.md'
const ids = (raw: string) => {
  const r = readBoardWidgets(raw, P)
  if (!r.ok) throw new Error(r.error)
  return r.items.map((w) => w.ref.id)
}
const text = (r: ReturnType<typeof addWidgetToBoard>) => {
  if (!r.ok) throw new Error(r.error)
  return r.text
}

describe('widget fence', () => {
  it('round-trips and stays out of the built-in card table', () => {
    const src = widgetRefSource({ id: 'w_7f3a1c9e0b12', scope: 'all' })
    expect(parseWidgetRef(src)).toEqual({ id: 'w_7f3a1c9e0b12', scope: 'all' })
    expect(parseWidgetRef(widgetRefSource({ id: 'w_1' }))).toEqual({ id: 'w_1' })
    expect(parseWidget(src)).toBeNull()
    expect(parseWidgetRef('```widget\nid: ../etc\n```')).toBeNull()
    expect(parseWidgetRef('```clock\n```')).toBeNull()
  })
})

describe('board edits', () => {
  it('creates a board, appends in order, ignores duplicates', () => {
    let raw = text(addWidgetToBoard(null, P, '卡片区', { id: 'w_a' }))
    raw = text(addWidgetToBoard(raw, P, '', { id: 'w_b' }))
    const again = addWidgetToBoard(raw, P, '', { id: 'w_a' })
    expect(again.ok && again.changed).toBe(false)
    expect(ids(raw)).toEqual(['w_a', 'w_b'])
    const lay = readDash3Layout(extractFrontmatterExtra(raw))
    expect(lay.ok && Object.values(lay.layout).map((c) => [c.w, c.h])).toEqual([[6, 5], [6, 5]])
  })

  it('appends after cards of a board that was never laid out', () => {
    const plain = text(addWidgetToBoard(null, P, 'x', { id: 'w_a' })).replace(/^dashboard3:.*$/m, '')
    const raw = text(addWidgetToBoard(plain, P, '', { id: 'w_b' }))
    expect(ids(raw)).toEqual(['w_a', 'w_b'])
  })

  it('removes, reorders and rescopes by widget id', () => {
    let raw = text(addWidgetToBoard(null, P, 'x', { id: 'w_a' }))
    raw = text(addWidgetToBoard(raw, P, '', { id: 'w_b' }))
    raw = text(addWidgetToBoard(raw, P, '', { id: 'w_c' }))
    raw = text(moveWidgetOnBoard(raw, P, 'w_c', 'w_a'))
    expect(ids(raw)).toEqual(['w_c', 'w_a', 'w_b'])
    raw = text(setWidgetScope(raw, P, 'w_a', 'all'))
    const r = readBoardWidgets(raw, P)
    expect(r.ok && r.items.find((w) => w.ref.id === 'w_a')?.ref.scope).toBe('all')
    raw = text(removeWidgetFromBoard(raw, P, 'w_a'))
    expect(ids(raw)).toEqual(['w_c', 'w_b'])
    // 删掉的号不复用
    raw = text(addWidgetToBoard(raw, P, '', { id: 'w_d' }))
    expect(raw).not.toMatch(/<!-- a 1 -->[\s\S]*w_d/)
  })

  it('refuses boards it cannot read instead of overwriting them', () => {
    const raw = text(addWidgetToBoard(null, P, 'x', { id: 'w_a' }))
    const future = raw.replace(/amadeus_schema: \S+/, 'amadeus_schema: amadeus.page/9')
    expect(addWidgetToBoard(future, P, '', { id: 'w_b' }).ok).toBe(false)
    const badLayout = raw.replace(/^dashboard3:.*$/m, 'dashboard3: oops')
    expect(addWidgetToBoard(badLayout, P, '', { id: 'w_b' }).ok).toBe(false)
    expect(removeWidgetFromBoard(badLayout, P, 'w_a').ok).toBe(false)
  })
})
