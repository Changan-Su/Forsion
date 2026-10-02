// V-19 JSON Canvas 单向导出(拍板 #10)。纯函数部分 + 写口的「绝不覆盖」。
import { describe, expect, it, vi } from 'vitest'
import { buildJsonCanvas, canvasExportPath, jsonCanvasText, writeJsonCanvas, type ExportFs } from './canvasExport'

const base = {
  cards: [
    { ref: 'k1', x: 480, y: 0, w: 300, h: 120, md: '## 卡 K1\n\n正文', color: '2' },
    { ref: 'k2', x: 880, y: 0, w: 300, h: 80, md: '![[子夹/会议纪要#议程|纪要]]' },
    { ref: 'k3', x: 880, y: 300, w: 300, h: 80, md: '![[不存在的笔记]]', color: 'red' },
  ],
  main: { x: 0, y: 0, w: 400, h: 200, md: '# 标题\n\n主卡正文' },
  elements: [
    { id: 'f1', type: 'frame', x: 1300, y: 300, w: 300, h: 200, title: '区域', color: '#12ab34' },
    { id: 's1', type: 'shape', shape: 'ellipse', x: 0, y: 300, w: 200, h: 120, text: '方块', note: 'future' },
    { id: 't1', type: 'text', x: 0, y: 500, w: 180, h: 40 },
    { id: 'c1', type: 'connector', from: { id: 's1' }, to: { ref: 'k1' }, label: '关系', color: '5', fromEnd: 'arrow', toEnd: 'none' },
    { id: 'c2', type: 'connector', from: { main: true }, to: { ref: 'k3' } },
    { id: 'c3', type: 'connector', from: { ref: 'gone' }, to: { ref: 'k1' } }, // 悬空:不导
    { id: 'bad', type: 'shape', x: 'nope' }, // 认不出:跳过这一条
  ],
  tree: { k2: 'k1', k3: 'm:' },
  pages: ['子夹/会议纪要.md', '月度计划.md', 'Note.md'],
  sourcePath: 'Note.md',
}

describe('buildJsonCanvas', () => {
  const out = buildJsonCanvas(base)
  const node = (id: string) => out.nodes.find((n) => n.id === id)
  const edge = (id: string) => out.edges.find((e) => e.id === id)

  it('Frame 在最底层(nodes 最前),是 group 节点', () => {
    expect(out.nodes[0]).toEqual({ id: 'el-f1', type: 'group', x: 1300, y: 300, width: 300, height: 200, label: '区域', color: '#12ab34' })
  })
  it('卡 → text 节点(内容 = markdown,颜色只导认得出的)', () => {
    expect(node('card-k1')).toEqual({ id: 'card-k1', type: 'text', x: 480, y: 0, width: 300, height: 120, text: '## 卡 K1\n\n正文', color: '2' })
    expect(node('card-k3')).toEqual({ id: 'card-k3', type: 'text', x: 880, y: 300, width: 300, height: 80, text: '![[不存在的笔记]]' })
  })
  it('卡恰好是一个能解析的嵌入 → file 节点(库内路径 + subpath,别名丢)', () => {
    expect(node('card-k2')).toEqual({ id: 'card-k2', type: 'file', x: 880, y: 0, width: 300, height: 80, file: '子夹/会议纪要.md', subpath: '#议程' })
  })
  it('形状 / 文本 → text 节点(外形丢、文字留;无字 = 空串)', () => {
    expect(node('el-s1')).toMatchObject({ type: 'text', text: '方块', x: 0, y: 300, width: 200, height: 120 })
    expect(node('el-t1')).toMatchObject({ type: 'text', text: '' })
    expect(node('el-bad')).toBeUndefined()
  })
  it('主卡 → text 节点 main', () => {
    expect(node('main')).toEqual({ id: 'main', type: 'text', x: 0, y: 0, width: 400, height: 200, text: '# 标题\n\n主卡正文' })
  })
  it('连线 → edge:端点映射、label / color / fromEnd·toEnd、出入边按画线规则', () => {
    expect(edge('edge-c1')).toEqual({ id: 'edge-c1', fromNode: 'el-s1', toNode: 'card-k1', fromEnd: 'arrow', toEnd: 'none', label: '关系', color: '5', fromSide: 'right', toSide: 'bottom' }) // k1 盒更扁:从它看 s1 竖直分量占优(与画面上线落在 k1 下沿一致)
    expect(edge('edge-c2')).toMatchObject({ fromNode: 'main', toNode: 'card-k3' })
    expect(edge('edge-c2')!.fromEnd).toBeUndefined() // 盘上没写 = 交给规范缺省
    expect(edge('edge-c3')).toBeUndefined()
  })
  it('层级 → edge(toEnd none,主卡哨兵 m: 连到 main)', () => {
    expect(edge('tree-k2')).toEqual({ id: 'tree-k2', fromNode: 'card-k1', toNode: 'card-k2', toEnd: 'none', fromSide: 'right', toSide: 'left' })
    expect(edge('tree-k3')).toMatchObject({ fromNode: 'main', toNode: 'card-k3', toEnd: 'none' })
  })
  it('主卡空且没人连它 → 不导出;有人连就导出', () => {
    const empty = { ...base, main: { ...base.main, md: '  ' } }
    expect(buildJsonCanvas({ ...empty, elements: [], tree: {} }).nodes.some((n) => n.id === 'main')).toBe(false)
    expect(buildJsonCanvas(empty).nodes.some((n) => n.id === 'main')).toBe(true)
  })
  it('没有名册 = 嵌入卡一律 text', () => {
    expect(buildJsonCanvas({ ...base, pages: undefined }).nodes.find((n) => n.id === 'card-k2')?.type).toBe('text')
  })
  it('文本形态:制表符缩进的合法 JSON', () => {
    const text = jsonCanvasText(out)
    expect(JSON.parse(text)).toEqual(out)
    expect(text).toContain('\n\t"nodes"')
  })
})

describe('canvasExportPath / writeJsonCanvas', () => {
  it('同目录、重名加后缀', () => {
    expect(canvasExportPath('Note.md')).toBe('Note.canvas')
    expect(canvasExportPath('a/b/Note.md', 3)).toBe('a/b/Note 3.canvas')
  })
  const fsOf = (files: Map<string, string>, createSupported = true): ExportFs & { writeTextFile: ReturnType<typeof vi.fn> } => ({
    readTextFile: async (p) => files.get(p) ?? null,
    writeTextFile: vi.fn(async (p: string, text: string, opts?: { create?: boolean }) => {
      if (createSupported && opts?.create && files.has(p)) return { ok: false as const, current: files.get(p)! }
      files.set(p, text)
      return createSupported && opts?.create ? { ok: true as const } : undefined
    }),
  })
  it('不覆盖已有文件:预查到就换下一个名字,写走 create:true', async () => {
    const files = new Map([['a/Note.canvas', 'OLD'], ['a/Note 2.canvas', 'OLD2']])
    const fs = fsOf(files)
    expect(await writeJsonCanvas(fs, 'a/Note.md', 'NEW')).toBe('a/Note 3.canvas')
    expect(files.get('a/Note.canvas')).toBe('OLD')
    expect(files.get('a/Note 2.canvas')).toBe('OLD2')
    expect(fs.writeTextFile).toHaveBeenCalledWith('a/Note 3.canvas', 'NEW', { create: true })
  })
  it('预查与写之间被别处占了名(宿主回 ok:false + 现文)→ 换下一个,不覆盖', async () => {
    const files = new Map<string, string>()
    const fs = fsOf(files)
    const realRead = fs.readTextFile
    let raced = false
    fs.readTextFile = async (p) => {
      const r = await realRead(p)
      if (!raced && p === 'Note.canvas') { raced = true; files.set('Note.canvas', 'RACER') }
      return r
    }
    expect(await writeJsonCanvas(fs, 'Note.md', 'NEW')).toBe('Note 2.canvas')
    expect(files.get('Note.canvas')).toBe('RACER')
  })
  it('宿主说没建成又拿不出现文 → 抛(不当成功)', async () => {
    const fs: ExportFs = { readTextFile: async () => null, writeTextFile: async () => ({ ok: false, current: null }) }
    await expect(writeJsonCanvas(fs, 'Note.md', 'x')).rejects.toThrow()
  })
})
