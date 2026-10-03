import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { documentAgentFence, newDocAgentSpec, parseDocAgentSpec, serializeDocAgentSpec, type DocAgentSpec } from './format'

describe('document agent persistence', () => {
  it('round-trips multiline prompts and existing session associations without truncation', () => {
    const spec: DocAgentSpec = { v: 1, id: 'task-1', agent: 'writer', prompt: '保留原文\n```md\nA < B\n```\n', sessionId: 'session-1' }
    expect(parseDocAgentSpec(serializeDocAgentSpec(spec))).toEqual(spec)
  })

  it.each([
    '', 'null', '[]', '{', '{}',
    '{"v":2,"id":"1","prompt":"future"}',
    '{"v":"1","id":"1","prompt":"x"}',
    '{"v":1,"id":"","prompt":"x"}',
    '{"v":1,"id":" x ","prompt":"x"}',
    '{"v":1,"id":"1","prompt":false}',
    '{"v":1,"id":"1","prompt":"x","agent":null}',
    '{"v":1,"id":"1","prompt":"x","sessionId":""}',
    '{"v":1,"id":"1","prompt":"x","approvalMode":"full-auto"}',
  ])('preserves invalid or unsupported data as source: %s', (body) => {
    expect(parseDocAgentSpec(body)).toBeNull()
  })

  it('creates distinct stable action identities without marking either task as submitted', () => {
    const first = newDocAgentSpec('writer', 'Draft a summary')
    const second = newDocAgentSpec('writer', 'Draft a summary')
    expect(first.id).not.toBe(second.id)
    expect(first).toMatchObject({ v: 1, agent: 'writer', prompt: 'Draft a summary' })
    expect(first.sessionId).toBeUndefined()
    expect(parseDocAgentSpec(serializeDocAgentSpec(first))).toEqual(first)
  })

  it('keeps pasted fences inside a single Instructions code node', () => {
    const body = 'Preserve examples:\n```md\n## Heading\n```\n````\nDo not drop this line.'
    const markdown = documentAgentFence('instructions', body)
    const tree = unified().use(remarkParse).parse(markdown)
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ type: 'code', lang: 'forsion-instructions', value: body })
  })

  it('does not mistake a surrounding fence or other Markdown for a JSON body', () => {
    const body = serializeDocAgentSpec(newDocAgentSpec())
    expect(parseDocAgentSpec(documentAgentFence('task', body))).toBeNull()
    expect(parseDocAgentSpec(`prefix\n${body}`)).toBeNull()
  })
})
