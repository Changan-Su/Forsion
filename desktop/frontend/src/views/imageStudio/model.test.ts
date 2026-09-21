import { describe, expect, it } from 'vitest'
import { arrangeImages, collectImageOutputs, imageBox, isImageBoard, newBoard, type StudioImage } from './model'

const photo = (id: string): StudioImage => ({ id, name: `${id}.png`, blob: new Blob(['png'], { type: 'image/png' }), width: 1200, height: 800, x: 0, y: 0, w: 300, h: 200, source: 'import', brightness: 100, contrast: 100, saturation: 100 })
describe('Image Studio project data', () => {
  it('accepts blobs and rejects corrupt geometry or executable image content', () => {
    const board = { ...newBoard('A'), images: [photo('one')] }
    expect(isImageBoard(board)).toBe(true)
    expect(isImageBoard({ ...board, images: [{ ...photo('one'), x: NaN }] })).toBe(false)
    expect(isImageBoard({ ...board, images: [{ ...photo('one'), blob: new Blob(['svg'], { type: 'image/svg+xml' }) }] })).toBe(false)
  })
  it('lays out different images without changing their aspect ratios or originals', () => {
    const inputs = [photo('a'), { ...photo('b'), width: 600, height: 1400 }, photo('c')]
    const arranged = arrangeImages(inputs)
    expect(arranged[1].w / arranged[1].h).toBeCloseTo(600 / 1400)
    expect(arranged[1].x).toBeGreaterThan(arranged[0].x + arranged[0].w)
    expect(arranged[2].y).toBeGreaterThan(arranged[0].y + arranged[0].h)
    expect(arranged[0].blob).toBe(inputs[0].blob)
    expect(imageBox(800, 1600, arranged).x).toBeGreaterThan(Math.max(...arranged.map(i => i.x + i.w)))
  })
  it('collects displayed images once and preserves their originating creative brief', () => {
    const file = { name: 'picture.png', mime: 'image/png', path: 'generated/picture.png' }
    const result = collectImageOutputs([
      { id: 'u1', role: 'user', content: 'First idea', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', displayFiles: [file, { name: 'readme.txt', path: 'readme.txt' }], timestamp: 2 },
      { id: 'a2', role: 'assistant', content: '', displayFiles: [file], timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Second idea', timestamp: 4 },
      { id: 'a3', role: 'assistant', content: '', displayFiles: [{ name: 'inline.png', dataUrl: 'data:image/png;base64,AA==' }], timestamp: 5 },
    ])
    expect(result).toHaveLength(2)
    expect(result.map(r => r.prompt)).toEqual(['First idea', 'Second idea'])
  })
})
