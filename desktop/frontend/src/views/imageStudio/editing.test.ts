import { describe, expect, it } from 'vitest'
import { boardItems, cloneItems, imageSize, isImageBoard, moveItems, newBoard, newElement, reorderItems, replaceItems, transformImage, validCrop, type StudioImage } from './model'
import { alignItems, escapeXml, exportScene } from './scene'
const photo = (id = 'image'): StudioImage => ({ id, name: 'A.png', blob: new Blob(['png'], { type: 'image/png' }), width: 800, height: 1000, x: 100, y: 100, w: 160, h: 200, source: 'import', brightness: 100, contrast: 100, saturation: 100 })
describe('Non-destructive image edits', () => {
  it('crops within original pixels, then rotates around the existing center without losing bytes', () => {
    const original = photo()
    const cropped = transformImage(original, { crop: { x: 0, y: 275, w: 800, h: 450 } })
    const rotated = transformImage(cropped, { rotation: 90, flipX: true })
    expect(imageSize(rotated)).toEqual({ w: 450, h: 800 })
    expect([rotated.w, rotated.h]).toEqual([90, 160])
    expect(rotated.x + rotated.w / 2).toBe(original.x + original.w / 2)
    expect(rotated.y + rotated.h / 2).toBe(original.y + original.h / 2)
    expect(rotated.blob).toBe(original.blob)
    expect(transformImage(rotated, { rotation: 0, crop: undefined, flipX: false })).toEqual({ ...original, rotation: 0, crop: undefined, flipX: false })
  })
  it('bounds arbitrary angles and refuses invalid crop rectangles', () => {
    expect(imageSize({ ...photo(), rotation: 45 }).w).toBeCloseTo(1800 / Math.sqrt(2))
    expect(validCrop({ x: 20, y: 0, w: 800, h: 500 }, 800, 1000)).toBe(false)
    expect(validCrop({ x: 0, y: 0, w: 0, h: 500 }, 800, 1000)).toBe(false)
    expect(validCrop({ x: 0, y: 0, w: 800, h: 1000 }, 800, 1000)).toBe(true)
  })
})
describe('Compatible mixed canvas documents', () => {
  it('accepts legacy v1 and complete v2, rejecting bad shapes and unsafe SVG values', () => {
    const old = { ...newBoard('Old'), version: 1 as const, images: [photo()], elements: undefined, order: undefined }
    expect(isImageBoard(old)).toBe(true)
    const board = replaceItems(old, [photo(), newElement('text', '<script>')])
    expect(isImageBoard(board)).toBe(true)
    expect(board.version).toBe(2)
    expect(isImageBoard({ ...board, elements: [{ ...board.elements![0], fill: 'url(https://example.com/a)' }] })).toBe(false)
    expect(isImageBoard({ ...board, elements: [null] })).toBe(false)
    expect(isImageBoard({ ...board, images: [{ ...photo(), crop: { x: -1, y: 0, w: 20, h: 20 } }] })).toBe(false)
    expect(isImageBoard({ ...board, images: [photo(), photo()] })).toBe(false)
    expect(escapeXml('<&"\'')).toBe('&lt;&amp;&quot;&apos;')
  })
  it('keeps the exact mixed layer order with frames behind artwork', () => {
    const a = photo('a'), b = newElement('text', 'Title'), c = photo('c'), frame = newElement('frame', 'Frame')
    const board = replaceItems(newBoard('A'), [a, b, c, frame])
    expect(boardItems(board).map(i => i.id)).toEqual([frame.id, 'a', b.id, 'c'])
    expect(boardItems(reorderItems(board, [b.id], 'up')).map(i => i.id)).toEqual([frame.id, 'a', 'c', b.id])
    expect(boardItems(reorderItems(board, ['c'], 'back')).map(i => i.id)).toEqual([frame.id, 'c', 'a', b.id])
  })
  it('moves frame contents exactly once, leaving locked/outside layers in place', () => {
    const frame = { ...newElement('frame', 'Frame'), w: 500, h: 500 }, a = photo('a'), locked = { ...photo('locked'), locked: true }, outside = { ...photo('out'), x: 900 }
    const board = replaceItems(newBoard('A'), [frame, a, locked, outside])
    const moved = moveItems(board, new Map([[frame.id, { ...frame, x: 80, y: 60 }], ['a', { ...a, x: 180, y: 160 }]]))
    expect(moved.images.map(i => [i.id, i.x, i.y])).toEqual([['a', 180, 160], ['locked', 100, 100], ['out', 900, 100]])
    expect(moveItems(board, new Map([['locked', { ...locked, x: 800 }]])).images[1].x).toBe(100)
  })
  it('duplicates independent ids while sharing immutable source bytes', () => {
    const original = [photo(), newElement('text', 'Title')], copies = cloneItems(original)
    expect(copies.map(i => i.id)).not.toEqual(original.map(i => i.id))
    expect(copies[0].x).toBe(132)
    expect((copies[0] as StudioImage).blob).toBe((original[0] as StudioImage).blob)
    expect(copies[1]).toMatchObject({ text: 'Title', locked: false })
  })
  it('exports a frame using exact bounds and intersecting visible objects only', () => {
    const frame = { ...newElement('frame', 'Frame'), x: 0, y: 0, w: 200, h: 200 }, a = photo('partial'), outside = { ...photo('out'), x: 900 }, hidden = { ...photo('hidden'), hidden: true }
    const board = replaceItems(newBoard('A'), [frame, a, outside, hidden])
    expect(exportScene(board, [frame.id])).toEqual({ bounds: frame, items: [frame, a] })
    expect(exportScene(board, ['hidden'])).toBeNull()
    expect(exportScene(board, ['partial'])?.items).toEqual([a])
  })
  it('aligns visible selection without shifting other or locked layers', () => {
    const a = photo('a'), b = { ...photo('b'), x: 500 }, locked = { ...photo('c'), x: 700, locked: true }
    const board = replaceItems(newBoard('A'), [a, b, locked])
    expect(alignItems(board, ['a', 'b', 'c'], 'left').images.map(i => i.x)).toEqual([100, 100, 700])
  })
})
