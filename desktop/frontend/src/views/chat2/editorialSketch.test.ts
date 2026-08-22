import { describe, expect, it } from 'vitest'
import type { SketchItem, ToolEvent } from '../../types'
import { partitionToolSegment } from './EditorialMessage'

const done = (id: string, name: string): ToolEvent => ({ id, name, done: true, result: 'ok' })

describe('EditorialMessage inline Sketch ordering', () => {
  it('places every completed Sketch immediately after its own tool call', () => {
    const events = [done('read1', 'read_file'), done('sk1', 'sketch'), done('run1', 'run_bash'), done('sk2', 'sketch')]
    const sketches: SketchItem[] = [
      { callId: 'sk1', html: '<p>ONE</p>' },
      { callId: 'sk2', html: '<p>TWO</p>' },
    ]
    const parts = partitionToolSegment(events, sketches)
    expect(parts.map((part) => part.t === 'tools' ? `tools:${part.events.map((ev) => ev.id).join(',')}` : `sketch:${part.item.callId}`)).toEqual([
      'tools:read1,sk1',
      'sketch:sk1',
      'tools:run1,sk2',
      'sketch:sk2',
    ])
  })

  it('keeps rejected or unfinished Sketch calls in the tool group without drawing a phantom card', () => {
    const events = [done('sk-bad', 'sketch'), done('read1', 'read_file')]
    expect(partitionToolSegment(events, [])).toEqual([{ t: 'tools', events }])
  })
})
