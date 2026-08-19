/** 缩进落盘互转的契约仪器(2026-08-14 Tab 缩进档位)。
 *  钉住:围栏/数学/frontmatter 不动、块级构造不动、双向互逆、用户字面 &#9; 文本不被劫持。 */
import { describe, it, expect } from 'vitest'
import { tabsToEntities, entitiesToTabs } from './indentIo'

describe('tabsToEntities(磁盘→解析)', () => {
  it('行首制表符逐枚转实体', () => {
    expect(tabsToEntities('\t缩进段')).toBe('&#9;缩进段')
    expect(tabsToEntities('\t\t两层')).toBe('&#9;&#9;两层')
  })

  it('段中制表符不动', () => {
    expect(tabsToEntities('前面\t后面')).toBe('前面\t后面')
  })

  it('纯制表符空行不动', () => {
    expect(tabsToEntities('\t\t')).toBe('\t\t')
  })

  it('制表符后是列表/引用构造:保留 CommonMark 嵌套语义不转', () => {
    expect(tabsToEntities('\t- item')).toBe('\t- item')
    expect(tabsToEntities('\t3. item')).toBe('\t3. item')
    expect(tabsToEntities('\t> quote')).toBe('\t> quote')
  })

  it('``` 围栏内不动(含 ~~~ 与围栏后信息串)', () => {
    const md = '```makefile\n\techo hi\n```\n\t真缩进段'
    expect(tabsToEntities(md)).toBe('```makefile\n\techo hi\n```\n&#9;真缩进段')
    const tilde = '~~~\n\tcode\n~~~'
    expect(tabsToEntities(tilde)).toBe(tilde)
  })

  it('$$ 数学块内不动', () => {
    const md = '$$\n\tx+y\n$$'
    expect(tabsToEntities(md)).toBe(md)
  })

  it('单行 $$x$$ 是行内公式段落,不许进假围栏态吞掉其后互转(评审 P1)', () => {
    expect(tabsToEntities('$$E=mc^2$$\n\n\t缩进段')).toBe('$$E=mc^2$$\n\n&#9;缩进段')
    expect(entitiesToTabs('$$E=mc^2$$\n\n&#9;缩进段')).toBe('$$E=mc^2$$\n\n\t缩进段')
    // 单行 ```x``` 同理(info string 不许含反引号,该行实为含 code span 的段落)
    expect(tabsToEntities('```code```\n\n\t缩进段')).toBe('```code```\n\n&#9;缩进段')
    // 真开栏(裸 $$ / 带 meta)仍然生效
    expect(tabsToEntities('$$\n\tx\n$$')).toBe('$$\n\tx\n$$')
  })

  it('头部 frontmatter 内不动', () => {
    const md = '---\nnote: |\n\ttab在这\n---\n\t正文缩进'
    expect(tabsToEntities(md)).toBe('---\nnote: |\n\ttab在这\n---\n&#9;正文缩进')
  })

  it('未闭合围栏:其后整段不动(宁可缩进失效不可改写代码)', () => {
    const md = '```\n\tcode1\n\tcode2'
    expect(tabsToEntities(md)).toBe(md)
  })
})

describe('entitiesToTabs(序列化→磁盘)', () => {
  it('行首实体串转制表符,大小写 x 双形态都收', () => {
    expect(entitiesToTabs('&#9;缩进段')).toBe('\t缩进段')
    expect(entitiesToTabs('&#x9;&#9;两层')).toBe('\t\t两层')
  })

  it('用户手打字面 &#9; 文本:序列化会带反斜杠转义,不被劫持', () => {
    expect(entitiesToTabs('\\&#9;字面文本')).toBe('\\&#9;字面文本')
  })

  it('行中实体不动', () => {
    expect(entitiesToTabs('文字&#9;中间')).toBe('文字&#9;中间')
  })

  it('实体+字面制表符混排(remark-stringify 只转义首枚):一并归一', () => {
    expect(entitiesToTabs('&#x9;\t两层')).toBe('\t\t两层')
    expect(entitiesToTabs('&#x9;\t\t三层')).toBe('\t\t\t三层')
  })

  it('余文是块级构造(-/>/1.):保实体落盘=不动点,不许转成 tabsToEntities 拒转的形态(评审 P1)', () => {
    expect(entitiesToTabs('&#9;- item')).toBe('&#9;- item')
    expect(entitiesToTabs('&#9;>看这里')).toBe('&#9;>看这里')
    expect(entitiesToTabs('&#9;1. 事项')).toBe('&#9;1. 事项')
  })

  it('引用/列表前缀之后的实体串:剥除(容器内缩进 md 表示不了,不留磁盘垃圾;评审 P2)', () => {
    expect(entitiesToTabs('> &#9;引用里的段')).toBe('> 引用里的段')
    expect(entitiesToTabs('- &#9;&#9;项内文')).toBe('- 项内文')
    // 用户手打的字面文本序列化必带反斜杠,不误伤
    expect(entitiesToTabs('> \\&#9;字面')).toBe('> \\&#9;字面')
  })

  it('纯字面制表符行首(已是磁盘形态):不动', () => {
    expect(entitiesToTabs('\t已经是磁盘形态&#9;后缀')).toBe('\t已经是磁盘形态&#9;后缀')
  })

  it('围栏代码内的字面 &#9; 字符串不动(HTML 示例代码)', () => {
    const md = '```html\n&#9;entity demo\n```'
    expect(entitiesToTabs(md)).toBe(md)
  })
})

describe('双向互逆', () => {
  it('tabs→entities→tabs 恒等', () => {
    const disk = '# 标题\n\n\t\t缩进段\n\n```sh\n\tmake\n```\n\n- item\n\n\t子段'
    expect(entitiesToTabs(tabsToEntities(disk))).toBe(disk)
  })

  it('无缩进文档零改动(引用恒等,省一次拷贝)', () => {
    const md = '# 平常\n\n段落而已'
    expect(tabsToEntities(md)).toBe(md)
    expect(entitiesToTabs(md)).toBe(md)
  })
})
