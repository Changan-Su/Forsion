import { describe, it, expect } from 'vitest'
import { parseButtonBlock, serializeButtonBlock, BLANK_BUTTON_BLOCK, type ButtonSpec } from './format'

describe('按钮块格式', () => {
  it('往返不变(含可选字段)', () => {
    const s: ButtonSpec = { v: 1, label: '整理今天的笔记', icon: '✨', triggerId: 'w-a1b2c3', confirm: '确定要跑吗' }
    expect(parseButtonBlock(serializeButtonBlock(s))).toEqual(s)
    expect(parseButtonBlock(BLANK_BUTTON_BLOCK)).toEqual({ v: 1, label: '', icon: undefined, triggerId: undefined, confirm: undefined })
  })

  it('坏 JSON / 非按钮内容一律 null —— 回落成普通代码块露源码,绝不代用户重写', () => {
    expect(parseButtonBlock('```forsion-button\n{"label": 缺引号}\n```')).toBeNull()
    expect(parseButtonBlock('```forsion-button\n[1,2]\n```')).toBeNull() // 数组不是配置对象
    expect(parseButtonBlock('```js\nconsole.log(1)\n```')).toBeNull()
    expect(parseButtonBlock('普通文字')).toBeNull()
  })

  it('围栏必须是整块 —— 前后有别的内容不认(否则会把半篇笔记吃成一个按钮)', () => {
    expect(parseButtonBlock('前言\n```forsion-button\n{"label":"x"}\n```')).toBeNull()
    expect(parseButtonBlock('```forsion-button\n{"label":"x"}\n```\n后记')).toBeNull()
  })

  it('字段类型不对 → 退成缺省而非整块作废(旧/新版本互读时不该白屏);版本号原样保留', () => {
    const s = parseButtonBlock('```forsion-button\n{"v":"9","label":42,"icon":"","triggerId":""}\n```')
    expect(s).toEqual({ v: 9, label: '', icon: undefined, triggerId: undefined, confirm: undefined })
  })
})
