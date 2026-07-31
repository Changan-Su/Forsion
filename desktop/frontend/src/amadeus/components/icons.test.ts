// 图标词表是**公开契约**(插件按名引用),坏掉的方式都是静默的,故钉住三条:
//
//  1. resolveIcon 的分流 —— 名字→组件、字形→原样、缺席→兜底。分流写歪了,插件图标会集体
//     退化成一串字面文本(`'template'` 直接画在菜单里),没有任何报错。
//  2. 词表键必须全是 [a-z0-9-] —— 这正是「老插件零改动」的**依据**:emoji / ✎ / · 永远命不中,
//     于是永远走字形分支。哪天有人往词表里塞一个 '⚡' 键,兼容承诺就悄悄破了。
//  3. 内置 slash 项一律用图标组件 —— 「按钮」曾经写成 `icon: '⚡'`,26 项里就它一个不是 SVG,
//     这条防的就是它再回来。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isValidElement } from 'react'
import { InformationIcon, PLUGIN_ICONS, resolveIcon } from './icons'

describe('插件图标词表', () => {
  it('名字命中 → 画组件', () => {
    const node = resolveIcon('callout-info')
    expect(isValidElement(node)).toBe(true)
    expect((node as { type: unknown }).type).toBe(InformationIcon)
  })

  it('emoji / 字形 → 原样返回(已发布插件零改动照跑)', () => {
    expect(resolveIcon('📌')).toBe('📌')
    expect(resolveIcon('✎')).toBe('✎')
  })

  it('缺席 → 兜底(调用方各自给)', () => {
    expect(resolveIcon(undefined, '·')).toBe('·')
    expect(resolveIcon('')).toBe(null)
  })

  it('词表键全是 [a-z0-9-],字形才永远命不中', () => {
    const bad = Object.keys(PLUGIN_ICONS).filter((k) => !/^[a-z0-9-]+$/.test(k))
    expect(bad).toEqual([])
  })
})

describe('内置 slash 项', () => {
  it('图标一律是组件,不许再混字形', () => {
    const src = readFileSync(new URL('../blocks/markdown/MarkdownBlock.tsx', import.meta.url), 'utf8')
    const from = src.indexOf('const SLASH_ITEMS')
    expect(from).toBeGreaterThan(0)
    const block = src.slice(from, src.indexOf('\n]\n', from))
    // 组件写法一律 `icon: <XxxIcon />`;`icon: '⚡'` 这种字形写法在这儿就红。
    expect(block.match(/icon: (?!<)/g)).toBeNull()
    expect(block.match(/icon: </g)?.length).toBeGreaterThan(20) // 确实扫到了整张表,不是切了个空片段
  })
})
