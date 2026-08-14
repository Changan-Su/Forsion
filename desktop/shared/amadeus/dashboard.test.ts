import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { COMPILER_VERSION, PAGE_SCHEMA, compile, parsePageSource, type PageManifest } from './compiler'
import { parseFmObject } from './db/pageFrontmatter'
import {
  DASH_COLS,
  DASH_MAX_ROWS,
  canPlace,
  clampRect,
  dashBaseName,
  findSlot,
  isDashboardPath,
  layoutIsStale,
  overlaps,
  parseDashLayout,
  parseWidget,
  readDashLayout,
  reconcileLayout,
  setDashInFm,
  snapDelta,
  webviewUrlAllowed,
  widgetSource,
} from './dashboard'

describe('路径判定', () => {
  it('只认 .dashboard.md', () => {
    expect(isDashboardPath('a/Foo.dashboard.md')).toBe(true)
    expect(isDashboardPath('Foo.DASHBOARD.MD')).toBe(true)
    expect(isDashboardPath('Foo.md')).toBe(false)
    expect(isDashboardPath('Foo.dashboard')).toBe(false) // 没有省略 .md 的写法(不像 excalidraw)
  })
  it('展示名去目录去后缀', () => {
    expect(dashBaseName('工作/周报.dashboard.md')).toBe('周报')
  })
})

describe('几何', () => {
  it('clamp 把块收进 24 列', () => {
    expect(clampRect({ x: 20, y: 0, w: 8, h: 4 })).toEqual({ x: 16, y: 0, w: 8, h: 4 })
    expect(clampRect({ x: -3, y: -2, w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(clampRect({ x: 0, y: 0, w: 99, h: 4 })).toEqual({ x: 0, y: 0, w: DASH_COLS, h: 4 })
  })
  it('相邻不算重叠', () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 })).toBe(false)
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 3, y: 3, w: 4, h: 4 })).toBe(true)
  })
  it('canPlace 拒绝越界与压块', () => {
    const layout = { a: { x: 0, y: 0, w: 6, h: 4 } }
    expect(canPlace('b', { x: 6, y: 0, w: 6, h: 4 }, layout)).toBe(true)
    expect(canPlace('b', { x: 4, y: 0, w: 6, h: 4 }, layout)).toBe(false) // 压住 a
    expect(canPlace('b', { x: 20, y: 0, w: 6, h: 4 }, layout)).toBe(false) // 越右界
    expect(canPlace('a', { x: 0, y: 0, w: 6, h: 4 }, layout)).toBe(true) // 自己不与自己冲突
  })
  it('findSlot 从左上往右下找,找不着就接底部', () => {
    expect(findSlot({}, 8, 6)).toEqual({ x: 0, y: 0, w: 8, h: 6 })
    expect(findSlot({ a: { x: 0, y: 0, w: 8, h: 6 } }, 8, 6)).toEqual({ x: 8, y: 0, w: 8, h: 6 })
    // 首行被 24 列占满 → 只能去下一行
    expect(findSlot({ a: { x: 0, y: 0, w: 24, h: 3 } }, 8, 6)).toEqual({ x: 0, y: 3, w: 8, h: 6 })
  })
  it('snapDelta 按步长取整', () => {
    expect(snapDelta(96, 0, 40, 36)).toEqual({ dx: 2, dy: 0 })
    expect(snapDelta(-30, 50, 40, 36)).toEqual({ dx: -1, dy: 1 })
  })
})

describe('reconcileLayout 自愈', () => {
  it('无变化时返回 null(不触发无谓落盘)', () => {
    const layout = { '1': { x: 0, y: 0, w: 8, h: 6 }, '2': { x: 8, y: 0, w: 8, h: 6 } }
    expect(reconcileLayout(layout, ['1', '2'])).toBeNull()
  })
  it('新块自动找位、消失的块被清掉', () => {
    const next = reconcileLayout({ '1': { x: 0, y: 0, w: 8, h: 6 }, '9': { x: 8, y: 0, w: 4, h: 4 } }, ['1', '2'])
    expect(next).not.toBeNull()
    expect(Object.keys(next!).sort()).toEqual(['1', '2'])
    expect(next!['1']).toEqual({ x: 0, y: 0, w: 8, h: 6 })
    expect(canPlace('2', next!['2'], next!)).toBe(true)
  })
  it('手改 md 改出的重叠被重新安置(先到先得,按文档顺序)', () => {
    const overlapping = { a: { x: 0, y: 0, w: 10, h: 6 }, b: { x: 2, y: 2, w: 10, h: 6 } }
    const next = reconcileLayout(overlapping, ['a', 'b'])!
    expect(next.a).toEqual({ x: 0, y: 0, w: 10, h: 6 }) // 文档里靠前的保住原位
    expect(overlaps(next.a, next.b)).toBe(false)
    expect(next.b.w).toBe(10) // 尺寸保留,只挪位置
  })
})

describe('frontmatter 往返', () => {
  it('读:flow 数组、块序列、坏值混在一起也只丢坏的那条', () => {
    expect(parseDashLayout({ dashboard: { '1': [0, 0, 8, 6], '2': ['x'], '3': [8, 0, 4, 4] } })).toEqual({
      '1': { x: 0, y: 0, w: 8, h: 6 },
      '3': { x: 8, y: 0, w: 4, h: 4 },
    })
    expect(parseDashLayout({})).toEqual({})
    expect(parseDashLayout(null)).toEqual({})
  })

  // readDashLayout 必须把「读不懂」与「没有布局」分开 —— 混为一谈时,坏在无关键上的 YAML
  // 会让自愈把用户真实布局整份覆盖成默认值(Codex 评审的 P0)。
  it('读:坏 YAML 明确报错,不伪装成空布局', () => {
    const bad = readDashLayout('tags: [未闭合\ndashboard:\n  "1": [12, 20, 5, 5]')
    expect(bad.ok).toBe(false)
    const empty = readDashLayout('tags: [a]')
    expect(empty).toEqual({ ok: true, layout: {} })
    expect(readDashLayout('')).toEqual({ ok: true, layout: {} })
  })
  it('写:坏 YAML 一律拒改(返回 null),绝不覆盖', () => {
    expect(setDashInFm('tags: [未闭合', { '1': { x: 0, y: 0, w: 4, h: 4 } })).toBeNull()
  })

  // 这一组是 Codex 复现出来的四种「合法输入 → 写成不可解析 frontmatter」。老实现全跪。
  const HOSTILE: Array<[string, string]> = [
    ['引号键', '"dashboard":\n  "1": [0, 0, 4, 4]\ntags: [a]'],
    ['根整体缩进', ' dashboard:\n   "1": [0, 0, 4, 4]\n tags: [a]'],
    ['键块里夹零缩进注释', 'dashboard:\n  "1": [0, 0, 4, 4]\n# 注释\n  "2": [4, 0, 4, 4]\ntags: [a]'],
    ['键块里夹空行', 'dashboard:\n  "1": [0, 0, 4, 4]\n\n  "2": [4, 0, 4, 4]\ntags: [a]'],
    ['CRLF', 'tags: [a]\r\ndashboard:\r\n  "1": [0, 0, 4, 4]\r\nicon: x'],
    ['多行块值里出现同名字面量', 'desc: |\n  第一行\n  dashboard: 这不是键\ntags: [a]'],
  ]
  it.each(HOSTILE)('写:%s —— 输出仍是可解析 YAML,布局读得回来', (_name, fm) => {
    const layout = { '1': { x: 9, y: 9, w: 9, h: 9 } }
    const out = setDashInFm(fm, layout)
    expect(out).not.toBeNull()
    const back = readDashLayout(out!)
    expect(back).toEqual({ ok: true, layout }) // 真 YAML 解析,不是自己写正则模拟
    expect(parseYaml(out!)).toBeTruthy()
  })

  it('写:用户其他 properties 与注释都留着', () => {
    const fm = '# 这是我的看板\ntags:\n  - 周报\n  - 工作\ndashboard:\n  "1": [0, 0, 4, 4]\nicon: 📊'
    const out = setDashInFm(fm, { '1': { x: 2, y: 1, w: 8, h: 6 } })!
    const obj = parseYaml(out) as Record<string, unknown>
    expect(obj.tags).toEqual(['周报', '工作'])
    expect(obj.icon).toBe('📊')
    expect(out).toContain('# 这是我的看板') // 注释也没丢(手写行替换器做不到)
    expect(out.match(/^dashboard:/gm)!.length).toBe(1)
  })
  it('写→读 闭合(过真 YAML)', () => {
    const layout = { '1': { x: 0, y: 0, w: 10, h: 6 }, '2': { x: 10, y: 0, w: 5, h: 4 } }
    expect(readDashLayout(setDashInFm('', layout)!)).toEqual({ ok: true, layout })
  })
  it('空布局 → 整个键消失,不留空键', () => {
    const out = setDashInFm('dashboard:\n  "1": [0, 0, 4, 4]\ntags: [a]', {})!
    expect(parseYaml(out)).toEqual({ tags: ['a'] })
    expect(out).not.toContain('dashboard')
  })
})

describe('恶意/退化数值', () => {
  it('1e308 这类合法有限数被夹住(否则 findSlot 逐行扫到天荒地老)', () => {
    const layout = parseDashLayout({ dashboard: { '1': [0, 0, 24, 1e308] } })
    expect(layout['1'].h).toBe(DASH_MAX_ROWS)
    expect(layout['1'].y).toBe(0)
    // 满格占住第一行之后再塞一块:必须立刻返回,不能扫 1e308 行
    const t0 = Date.now()
    const slot = findSlot(layout, 8, 6)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(slot.y).toBe(DASH_MAX_ROWS)
  })
  it('NaN / 字符串混进来不会污染网格', () => {
    expect(clampRect({ x: NaN, y: NaN, w: NaN, h: NaN })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('网页卡片 URL 闸门', () => {
  it('放行公网 http(s)', () => {
    expect(webviewUrlAllowed('https://example.com/a?b=1')).toBe(true)
    expect(webviewUrlAllowed('http://93.184.216.34/')).toBe(true)
  })
  it('拒非 http(s) 协议', () => {
    for (const u of ['file:///etc/hosts', 'data:text/html,<script>1</script>', 'javascript:alert(1)', 'about:blank', 'not a url'])
      expect(webviewUrlAllowed(u)).toBe(false)
  })
  it('拒 localhost 与私网/链路本地(内网探测 + 对本机服务发 GET 型副作用)', () => {
    for (const h of [
      'http://localhost:3000/admin/delete?id=1',
      'http://127.0.0.1:8080/',
      'http://[::1]:8080/',
      'http://10.0.0.5/',
      'http://172.16.3.4/',
      'http://172.31.255.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // 云元数据
      'http://0.0.0.0/',
      'http://100.64.0.1/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) expect(webviewUrlAllowed(h), h).toBe(false)
  })
  it('公网段里长得像私网的不误杀', () => {
    expect(webviewUrlAllowed('http://172.32.0.1/')).toBe(true) // 172.16-31 之外
    expect(webviewUrlAllowed('http://192.169.1.1/')).toBe(true)
  })
})

// 这一组是整个方案的地基:「Dashboard 就是一份普通 Amadeus 笔记,布局走外来 frontmatter 键,
// 编译内核一个字节都不用改」。真拿 compile()/parsePageSource() 跑一遍 —— 哪天有人动了 fmExtra
// 的保留键过滤或 frontmatter 拼装,这里先红,而不是等用户报「布局丢了」。
describe('过真编译器往返(零内核改动的证明)', () => {
  const build = (fmExtra: string): PageManifest => ({
    schema: PAGE_SCHEMA,
    id: 'pg_test0001',
    title: 'demo',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    compiler: { version: COMPILER_VERSION },
    root: {
      type: 'stack',
      children: [{ type: 'row', id: 'row_1', columns: [{ id: 'col_1', width: 1, children: [{ ref: '1' }, { ref: '2' }] }] }],
    },
    blocks: { '1': { type: 'markdown' }, '2': { type: 'markdown' } },
    fmExtra,
  })

  it('布局键落盘后读得回来,块内容也没被改写', () => {
    const layout = { '1': { x: 0, y: 0, w: 14, h: 8 }, '2': { x: 14, y: 0, w: 5, h: 4 } }
    const clock = widgetSource('clock', { tz: 'Asia/Shanghai' })
    const src = compile(build(setDashInFm('tags: [看板]', layout)!), { '1': '# 标题', '2': clock })
    const back = parsePageSource('a/demo.dashboard.md', src, '2026-07-30T00:00:00.000Z')
    expect(parseDashLayout(parseFmObject(back.manifest.fmExtra ?? ''))).toEqual(layout)
    expect(back.blocks['1'].content).toBe('# 标题')
    expect(parseWidget(back.blocks['2'].content)).toEqual({ kind: 'clock', opts: { tz: 'Asia/Shanghai' } })
    expect(parseFmObject(back.manifest.fmExtra ?? '').tags).toEqual(['看板'])
  })

  // Codex 评审 #6 原题:非数字块 id 会让 parseV3 全篇重编号成 1..N 而只 remap amadeus_layout,
  // 外来的 dashboard 键仍指旧 id → 脱钩。2026-08-13 起合法唯一 id 一律保号,这条引信已拆
  // (下面第一段断言);但外部写手(agent 覆盖写正文换掉 id)仍可能脱钩,防线不变:
  // 「认出来并停手」,不自动重排 —— 这条链依旧**不在** compiler 里补。
  it('合法字母 id 不再被重编号(dashboard 键保持绑定);真脱钩仍被 layoutIsStale 认出来', () => {
    const layout = { old_a: { x: 0, y: 0, w: 8, h: 6 }, old_b: { x: 8, y: 0, w: 8, h: 6 } }
    const mk = (ids: [string, string]) => [
      '---',
      'amadeus_page: pg_legacy01',
      'amadeus_schema: amadeus.page/3',
      'amadeus_layout: {"type":"stack","children":[]}',
      setDashInFm('', layout)!,
      '---',
      '',
      `<!-- a ${ids[0]} -->`,
      '',
      '甲',
      '',
      `<!-- a ${ids[1]} -->`,
      '',
      '乙',
      '',
    ].join('\n')

    // 引信已拆:字母 id 原样保留,dashboard 键仍指向在场的块 → 不 stale,不再脱钩。
    const kept = parsePageSource('Legacy.dashboard.md', mk(['old_a', 'old_b']), '2026-07-30T00:00:00.000Z')
    const keptIds = Object.keys(kept.blocks).sort()
    expect(keptIds).toEqual(['old_a', 'old_b'])
    const keptBack = readDashLayout(kept.manifest.fmExtra ?? '')
    expect(keptBack.ok).toBe(true)
    expect(keptBack.ok && layoutIsStale(keptBack.layout, keptIds)).toBe(false)

    // 残余脱钩类(外部写手换掉全部块 id,fm 布局原样):必须被认出来并停手。
    const severed = parsePageSource('Legacy.dashboard.md', mk(['n1', 'n2']), '2026-07-30T00:00:00.000Z')
    const severedIds = Object.keys(severed.blocks).sort()
    expect(severedIds).toEqual(['n1', 'n2'])
    const severedBack = readDashLayout(severed.manifest.fmExtra ?? '')
    expect(severedBack.ok && layoutIsStale(severedBack.layout, severedIds)).toBe(true)
  })
  it('layoutIsStale 只在「一个都对不上」时为真(部分新块不算)', () => {
    const l = { '1': { x: 0, y: 0, w: 4, h: 4 } }
    expect(layoutIsStale(l, ['1', '2'])).toBe(false) // 2 是新块,正常自愈
    expect(layoutIsStale(l, ['7', '8'])).toBe(true)
    expect(layoutIsStale({}, ['1'])).toBe(false) // 全新文件,不是 stale
    expect(layoutIsStale(l, [])).toBe(false)
  })

  it('被普通笔记编辑器打开→保存(布局键原样过一手)也不丢布局', () => {
    const layout = { '1': { x: 3, y: 2, w: 6, h: 5 }, '2': { x: 9, y: 2, w: 6, h: 5 } }
    let src = compile(build(setDashInFm('', layout)!), { '1': 'a', '2': 'b' })
    const opened = parsePageSource('demo.dashboard.md', src, '2026-07-30T00:00:00.000Z')
    // 编辑器里改了一个块的字,原样再存(fmExtra 走 manifest 回写)
    src = compile(opened.manifest, { '1': 'a 改过了', '2': 'b' })
    const again = parsePageSource('demo.dashboard.md', src, '2026-07-30T00:00:00.000Z')
    expect(parseDashLayout(parseFmObject(again.manifest.fmExtra ?? ''))).toEqual(layout)
    expect(again.blocks['1'].content).toBe('a 改过了')
  })
})

describe('功能卡片 fence', () => {
  it('认三种 widget 并解出参数', () => {
    expect(parseWidget('```clock\ntz: Asia/Shanghai\nlabel: 上海\n```')).toEqual({
      kind: 'clock',
      opts: { tz: 'Asia/Shanghai', label: '上海' },
    })
    expect(parseWidget('```weather\n```')).toEqual({ kind: 'weather', opts: {} })
    expect(parseWidget('```webview\nurl: https://a.com\n```')?.kind).toBe('webview')
  })
  it('普通代码块 / 混着正文 一律不认', () => {
    expect(parseWidget('```js\nconst a = 1\n```')).toBeNull()
    expect(parseWidget('前面有字\n```clock\n```')).toBeNull()
    expect(parseWidget('# 标题')).toBeNull()
  })
  it('widgetSource → parseWidget 闭合', () => {
    const src = widgetSource('clock', { tz: 'UTC', label: '' })
    expect(parseWidget(src)).toEqual({ kind: 'clock', opts: { tz: 'UTC' } }) // 空值不落盘
    expect(parseWidget(widgetSource('weather'))).toEqual({ kind: 'weather', opts: {} })
  })
})
