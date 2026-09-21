import { describe, expect, it } from 'vitest'
import { centerCropForAspect, formatAspectRatio, generationBoxes, imageToolRequest, outputRatioPlan } from './generation'
import { newBoard, type StudioImage } from './model'

const image = (patch: Partial<StudioImage> = {}): StudioImage => ({
  id: 'source', name: 'source.png', blob: new Blob(['x'], { type: 'image/png' }), width: 800, height: 1000,
  x: 40, y: 60, w: 240, h: 300, source: 'import', brightness: 100, contrast: 100, saturation: 100, ...patch,
})

describe('Image Studio generation planning', () => {
  it('offers the visible source ratio while choosing the closest engine family', () => {
    const plan = outputRatioPlan(image(), 'original')
    expect(plan).toMatchObject({ requested: '4:5', engine: '2:3', aspect: .8, originalLabel: '4:5' })
    expect(formatAspectRatio(1470, 1000)).toBe('1.47:1')
  })

  it('reserves stable boxes beside the selected source', () => {
    const board = { ...newBoard('Test'), images: [image()] }
    const boxes = generationBoxes(board, { count: 2, aspect: .8, ratio: '4:5', kind: 'edit', sourceIds: ['source'] })
    expect(boxes).toEqual([
      { x: 312, y: 60, w: 240, h: 300 },
      { x: 584, y: 60, w: 240, h: 300 },
    ])
  })

  it('center-crops an engine result to the requested display ratio without changing source bytes', () => {
    expect(centerCropForAspect(1024, 1536, .8)).toEqual({ x: 0, y: 128, w: 1024, h: 1280 })
    expect(centerCropForAspect(800, 1000, .8)).toBeUndefined()
  })

  it('derives placeholder count and ratio from image tool calls', () => {
    expect(imageToolRequest('generate_image', '{"size":"16:9","n":3}')).toMatchObject({ count: 3, ratio: '16:9', kind: 'generate' })
    expect(imageToolRequest('run_bash', '{}')).toBeNull()
  })
})
