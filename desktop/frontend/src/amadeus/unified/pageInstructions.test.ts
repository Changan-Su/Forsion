import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { instructionsOf, pageInstructionContext } from './pageInstructions'

const schema = new Schema({ nodes: {
  doc: { content: 'block*' }, text: {},
  code_block: { content: 'text*', group: 'block', attrs: { language: { default: '' } } },
  blockquote: { content: 'block*', group: 'block' },
} })
const code = (text: string, language = 'forsion-instructions') => schema.nodes.code_block.create({ language }, schema.text(text))

describe('page instructions in editor contexts', () => {
  it('uses only top-level dedicated blocks in document order', () => {
    const doc = schema.nodes.doc.create(null, [code(' First '), schema.nodes.blockquote.create(null, code('Not a rule')), code('Not a rule', 'text'), code('Second')])
    expect(instructionsOf(doc)).toBe('First\n\nSecond')
  })
  it('does not inherit instructions from previously read pages', () => {
    expect(instructionsOf(schema.nodes.doc.create(null, code('First page')))).toBe('First page')
    expect(instructionsOf(schema.nodes.doc.create())).toBe('')
    expect(pageInstructionContext('', 'other.md')).toBe('')
  })
  it('bounds inline input and quotes the scope path', () => {
    expect(instructionsOf(schema.nodes.doc.create(null, code('a'.repeat(13_000))))).toHaveLength(12_000)
    expect(pageInstructionContext('Use English', 'Note\nOther.md')).toContain('"Note\\nOther.md"')
  })
})
