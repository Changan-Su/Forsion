import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseUIDraft, safeUIUrl, snapUIValue, validateUIDocument } from './intelligentUi.js'
const fixtures = JSON.parse(readFileSync(new URL('../../../desktop/scripts/fixtures/intelligent-ui.json', import.meta.url), 'utf8'))
const dinner = () => structuredClone(fixtures.dinner)

describe('Intelligent UI trust boundary and semantic streaming', () => {
  it('accepts plans, galleries and sources with complete references', () => {
    for (const value of Object.values(fixtures)) expect(validateUIDocument(value).blocks.length).toBeGreaterThan(0)
  })
  it('never commits incomplete records at any character boundary', () => {
    const full = JSON.stringify(fixtures.dinner)
    let count = 0
    for (let i = 1; i <= full.length; i++) {
      const parsed = parseUIDraft(full.slice(0, i))
      if (!parsed) continue
      expect(parsed.blocks.length).toBeGreaterThanOrEqual(count)
      expect(parsed.blocks).toEqual(validateUIDocument(fixtures.dinner).blocks.slice(0, parsed.blocks.length))
      count = parsed.blocks.length
    }
    expect(count).toBe(fixtures.dinner.blocks.length)
  })
  it('handles escaped quotes, array-looking prose and braces without guessing', () => {
    const doc = dinner(); doc.blocks[0].markdown = 'Quoted "blocks": [ and } with \\ paths 😃'
    expect(parseUIDraft(JSON.stringify(doc))).toEqual(validateUIDocument(doc))
  })
  it('rejects partial metadata, missing references and invalid finished blocks', () => {
    expect(parseUIDraft('{"version":1,"id":"x","title":"x","blocks":[')).toBeUndefined()
    const doc = dinner(); doc.blocks[1].inputIds.push('missing')
    expect(() => validateUIDocument(doc)).toThrow('unknown input')
    expect(parseUIDraft(JSON.stringify(doc))?.blocks).toEqual([validateUIDocument(dinner()).blocks[0]])
  })
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:image/svg+xml,test', 'https://u:pass@example.com/p', 'https://127.0.0.1', 'https://0x7f000001', 'https://[::1]', 'https://localhost', 'https://x.local', 'https://localhost./x', 'https://host.local./x', 'https://host.internal./x', 'https://example.com:444/p'])('rejects nonpublic URL %s', url => expect(safeUIUrl(url)).toBe(false))
  it('rejects duplicate IDs, unknown kinds, poison keys and invalid numeric bounds', () => {
    const a = dinner(); a.blocks.push(a.blocks[0]); expect(() => validateUIDocument(a)).toThrow('duplicate')
    const b = dinner(); b.blocks[0].kind = 'html'; expect(() => validateUIDocument(b)).toThrow('unknown block')
    const c = dinner(); c.inputs[0].id = '__proto__'; expect(() => validateUIDocument(c)).toThrow('invalid ID')
    const d = dinner(); d.inputs[0].initial = 99; expect(() => validateUIDocument(d)).toThrow('expected number')
    const e = dinner(); e.blocks[3].items[0].quantity.base = 0; expect(() => validateUIDocument(e)).toThrow('expected number')
  })
  it('does not pass arbitrary attributes through to native components', () => {
    const doc = dinner(); doc.blocks[0].onclick = 'alert(1)'; doc.blocks[0].style = { position: 'fixed' }
    expect(validateUIDocument(doc).blocks[0]).not.toHaveProperty('onclick')
    expect(validateUIDocument(doc).blocks[0]).not.toHaveProperty('style')
  })
  it('rejects invisible controls while allowing an unfinished prefix', () => {
    const doc = dinner(); doc.blocks = doc.blocks.filter((b: any) => b.kind !== 'controls')
    expect(() => validateUIDocument(doc)).toThrow('every declared input')
    expect(validateUIDocument(doc, { draft: true }).inputs).toHaveLength(2)
  })
  // 真模型(10-13):模型爱在末尾的追问钮前面把同一组输入再列一遍。拒收会留下一张残缺的卡再跟一张重写的,所以只保留第一次出现的位置。
  it('shows an input once: a repeat in a later controls block is dropped, an emptied block with it', () => {
    const first = dinner().blocks.find((b: any) => b.kind === 'controls')
    const twice = dinner(); twice.blocks.push({ ...first, id: 'duplicate' })
    expect(validateUIDocument(twice).blocks).toEqual(validateUIDocument(dinner()).blocks)
    // 后一个控件块里有新的输入时,只去掉重复的那个
    const mixed = dinner(); const [a, b] = first.inputIds
    mixed.blocks = mixed.blocks.map((x: any) => x.kind === 'controls' ? { ...x, inputIds: [a] } : x)
    mixed.blocks.push({ id: 'ask', kind: 'controls', inputIds: [a, b] })
    const out = validateUIDocument(mixed).blocks.filter((x) => x.kind === 'controls')
    expect(out.map((x: any) => x.inputIds)).toEqual([[a], [b]])
    // 重复的那块自己带标题(「我还想确认两件事」):标题留着,只是不再重复画控件
    const titled = dinner(); titled.blocks.push({ ...first, id: 'ask', title: '还想确认两件事' })
    expect(validateUIDocument(titled).blocks.at(-1)).toMatchObject({ id: 'ask', kind: 'controls', title: '还想确认两件事', inputIds: [] })
    // 重复的那块带 when:照旧拒收(控件必须一直可见),不因为它会被去掉就放过
    const hidden = dinner(); hidden.blocks.push({ ...first, id: 'dup', when: { input: a, equals: hidden.inputs.find((x: any) => x.id === a).initial } })
    expect(() => validateUIDocument(hidden)).toThrow('controls must remain visible')
  })
  it('accepts picture options only as a complete row of image references', () => {
    const pick = (): any => structuredClone(fixtures.pick)
    expect(validateUIDocument(pick()).inputs[0]).toMatchObject({ kind: 'choice', options: [{ imageId: 'jetty' }, { imageId: 'diagonal' }, { imageId: 'shore' }] })
    const mixed = pick(); delete mixed.inputs[0].options[1].imageId
    expect(() => validateUIDocument(mixed)).toThrow('every option or none')
    const source = pick(); source.inputs[0].options[0].imageId = 'origin'
    expect(() => validateUIDocument(source)).toThrow('expected image resource reference')
    const missing = pick(); missing.inputs[0].options[0].imageId = 'nowhere'
    expect(() => validateUIDocument(missing)).toThrow('expected image resource reference')
    // A streamed prefix validates the same references, so a card can never point at a missing picture.
    expect(parseUIDraft(JSON.stringify(missing))).toBeUndefined()
    expect(parseUIDraft(JSON.stringify(pick()))).toEqual(validateUIDocument(pick()))
  })
  it('normalizes decimal step values so conditions match after repeated clicks', () => {
    const doc = dinner(); Object.assign(doc.inputs[0], { min: 0, max: 1, step: 0.1, initial: 0.3 })
    expect(() => validateUIDocument(doc)).not.toThrow()
    let value = 0
    for (let i = 0; i < 3; i++) value = snapUIValue(value + 0.1, doc.inputs[0])
    expect(value).toBe(0.3)
  })
})
