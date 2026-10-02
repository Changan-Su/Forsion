// 笔记交互块(```forsion-sketch):围栏拼法 + 嵌入层认领口径。
import { describe, it, expect } from 'vitest'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { sketchFence, SKETCH_LANG } from './format'
import { classifyEmbed } from '../../unified/embedLayer'

const code = (language: string, textContent: string) => ({ type: { name: 'code_block' }, attrs: { language }, textContent }) as unknown as ProseNode

describe('sketchFence', () => {
  it('普通 HTML → 三反引号围栏,去掉尾部空白', () => {
    expect(sketchFence('<b>hi</b>\n\n')).toBe('```forsion-sketch\n<b>hi</b>\n```')
  })
  it('HTML 里有 ``` → 围栏比最长的反引号串多一根', () => {
    expect(sketchFence('<pre>```js</pre>')).toBe('````forsion-sketch\n<pre>```js</pre>\n````')
  })
})

describe('classifyEmbed · forsion-sketch', () => {
  it('有内容 → sketch 嵌入', () => {
    expect(classifyEmbed(code(SKETCH_LANG, '<b>x</b>'))).toEqual({ k: 'sketch', src: '<b>x</b>' })
  })
  it('空块不认领(源码要露着才写得进去);别的语言照旧是代码', () => {
    expect(classifyEmbed(code(SKETCH_LANG, '  \n'))).toBeNull()
    expect(classifyEmbed(code('html', '<b>x</b>'))).toBeNull()
  })
})
