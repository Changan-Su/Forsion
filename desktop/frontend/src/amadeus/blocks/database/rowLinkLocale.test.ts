// 钉住:关联芯片的空值文案跟随界面语言。
// 这条曾经是英文界面里裸露的「未命名」——linkLabel 是纯函数、没有 hook,当年就一直硬编码。
// 姊妹测试 rowLink.test.ts / dbRowLink.test.ts 断言的是 zh 那一侧(它们显式 setLocaleGlobal('zh')),
// 只有这里会因为「又改回硬编码中文」而红。
import { describe, expect, it } from 'vitest'
import { linkLabel } from '@/amadeus/blocks/database/rowLink'
import { setLocaleGlobal } from '@/i18n'
import type { DbFile } from '@amadeus-shared/db/schema'

const DB = { version: 1, name: 'x', columns: [{ id: 'a', name: 'A', type: 'text' }], rows: [{ rowId: 'r1', cells: {} }] } as unknown as DbFile

describe('linkLabel 空值文案跟随语言', () => {
  it('zh → 未命名 / en → Untitled', () => {
    setLocaleGlobal('zh'); expect(linkLabel(DB, DB.rows[0])).toBe('未命名')
    setLocaleGlobal('en'); expect(linkLabel(DB, DB.rows[0])).toBe('Untitled')
    setLocaleGlobal('zh') // 复位:模块级 _locale 是全局的,别污染同批其它测试
  })
})
