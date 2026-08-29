/**
 * 「整个界面被顶歪」的回归闸:两个满屏外壳必须是 overflow: clip。
 * hidden 同样看不见溢出,但它**仍然是个滚动容器** —— 浏览器给焦点元素做 scrollIntoView 时会把整个壳
 * 横/竖滚起来(ribbon + 标题栏被推出视野、侧栏文字左边被切),而且没有滚动条能滚回来,只能重启。
 * clip 压根不建滚动容器。用户 2026-08-28 报的「界面有时候会变成这样」即此。
 * 反向验证:把任意一条改回 hidden,本测必红;真浏览器里的行为复现见 npm run check:shellnoscroll。
 * (注:body/html 不在此列 —— 实测视口不论 hidden 还是 clip 都拦不住程序化滚动,只能靠壳自己 clip。)
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const block = (file: string, selector: string): string => {
  const css = readFileSync(resolve(__dirname, file), 'utf8')
  const i = css.search(new RegExp('^' + selector.replace('.', '\\.') + ' \\{', 'm'))
  expect(i, `${file} 里找不到 ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}

describe('满屏外壳不得是滚动容器', () => {
  it.each([
    ['../../../../lcl/engine/engine.css', '.shell'],
    ['../../../../lcl/engine/singleColumn.css', '.mb-shell'],
  ])('%s 的 %s 用 clip 而非 hidden', (file, sel) => {
    const b = block(file, sel)
    expect(b).toContain('overflow: clip')
    expect(b).not.toContain('overflow: hidden')
  })
})
