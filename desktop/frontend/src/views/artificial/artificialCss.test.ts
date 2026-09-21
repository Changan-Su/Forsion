/**
 * 造物栅格的 CSS 纪律闸(2026-09-21 对抗评审 #9)。
 *
 * 病理:卡片复用了启动器的 `.newtab-card`,而 base.css 给它写了
 * `:hover { border-color: var(--accent-ink); background: var(--overlay-light); transform: translateY(-1px) }`
 * —— 那是给「整张卡就是一颗按钮」的启动器写的。造物的卡是**容器**:能点的只有里面那颗
 * `data-action=open`(既不能启动又没有工作室可去时它还是灰的)。整张卡跟着抬 = 悬浮反馈在说谎,
 * 而且给内容卡描了边(DESIGN.md §5「内容卡不描边」)。
 *
 * 这一条没有运行时断言可用:happy-dom 模拟不了 `:hover`,几何断言也照不出「悬浮时才发生的事」。
 * 所以按文本量,并且**连同位置一起量** —— 覆盖块必须留在文件末尾(DESIGN.md §7:同特异性的
 * 覆盖块写在中间,会被后面任何一条同名规则默默吃掉)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(__dirname, 'artificial.css'), 'utf8')

/** 按声明顺序取出 `选择器 { 声明 }`(本文件没有嵌套规则 / @media,平铺扫描足够)。 */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(),
  body: m[2],
}))

describe('造物栅格:卡片的悬浮反馈', () => {
  it('⚠️整张卡不许跟着抬 / 描边(继承自 .newtab-card 的三条要按原值还原)', () => {
    const rule = RULES.find((r) => r.selector === '.newtab-card.art-card:hover')
    expect(rule, '缺少 .newtab-card.art-card:hover 覆盖块').toBeTruthy()
    expect(rule!.body).toMatch(/transform:\s*none/)
    expect(rule!.body).toMatch(/border-color:\s*var\(--border\)/)
    expect(rule!.body).toMatch(/background:\s*var\(--bg-card\)/)
  })

  it('⚠️覆盖块必须留在文件末尾(写在中间会被后面的同名规则默默吃掉)', () => {
    const at = RULES.findIndex((r) => r.selector === '.newtab-card.art-card:hover')
    expect(at).toBeGreaterThanOrEqual(0)
    // 后面只允许还留着同属覆盖块的规则(本文件目前就一条:把反馈收给真正能点的那颗主按钮)。
    for (const rest of RULES.slice(at + 1)) {
      expect(rest.selector, `覆盖块之后又出现了普通规则:${rest.selector}`).toMatch(/^\.art-card-main/)
    }
  })

  it('悬浮反馈收给真正能点的那颗主按钮(禁用态不许亮)', () => {
    const rule = RULES.find((r) => r.selector.startsWith('.art-card-main') && r.selector.includes(':hover'))
    expect(rule, '主按钮没有自己的悬浮反馈').toBeTruthy()
    expect(rule!.selector).toContain(':not(:disabled)')
    expect(rule!.body).toMatch(/var\(--[a-z-]+\)/) // 只吃 token,不写死颜色
  })
})

describe('造物栅格:CSS 纪律', () => {
  it('不写全局滚动条、不自起高程、颜色只吃 token', () => {
    expect(CSS).not.toMatch(/::-webkit-scrollbar/)
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/box-shadow\s*:/)
    // #fff 是 guest 白底(与 .csp-viewport 同一条先例);除此之外不许再出现写死的颜色。
    const colors = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map((m) => m[0])
    expect(colors).toEqual(['#fff'])
  })
})
