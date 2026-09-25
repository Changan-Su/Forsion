/**
 * 「已选择」引用芯片的纯逻辑。
 *
 * 钉住的不变式:**芯片 token 原样拼回 = 行内插入的那段文本**。引擎、消息气泡、read_session 全靠这条,
 * 一旦 refChipOf 把 token 改写(哪怕只是丢个引号),下游收到的引用就变了而界面上看不出来 —— 所以
 * 每条用例都反向断言 token,而不只断言名字。
 */
import { describe, expect, it } from 'vitest'
import { refChipOf, fileChip, folderChip, viewChip } from './Composer2'
import { refToText, type ChatRef } from './chatDragRef'
import { splitLeadingRefs } from './RefChipView'

const VAULT = '/Users/x/vault'
const roundTrip = (r: ChatRef): void => expect(refChipOf(r, VAULT).token).toBe(refToText(r, VAULT).trim())

describe('refChipOf', () => {
  it('笔记:token = [[vault 绝对路径|名字]],芯片显示文件名', () => {
    const c = refChipOf({ kind: 'note', path: '快速开始.md' }, VAULT)
    expect(c).toEqual({ token: `[[${VAULT}/快速开始.md|快速开始]]`, name: '快速开始.md', kind: 'note' })
    roundTrip({ kind: 'note', path: '快速开始.md' })
  })

  it('子文件夹里的笔记:token 带完整相对路径,名字只取 basename', () => {
    const r: ChatRef = { kind: 'note', path: '项目/周报.md' }
    expect(refChipOf(r, VAULT)).toEqual({ token: `[[${VAULT}/项目/周报.md|周报]]`, name: '周报.md', kind: 'note' })
    roundTrip(r)
  })

  it('会话:session 芯片(不是 note),标题即名字', () => {
    const r: ChatRef = { kind: 'session', id: 'abc', title: '昨天那个 bug' }
    expect(refChipOf(r, VAULT)).toEqual({ token: '[[session:abc|昨天那个 bug]]', name: '昨天那个 bug', kind: 'session' })
    roundTrip(r)
  })

  it('本机文件:token = 路径原样,名字取 basename', () => {
    const r: ChatRef = { kind: 'file', path: '/tmp/a/b.txt' }
    expect(refChipOf(r, VAULT)).toEqual({ token: '/tmp/a/b.txt', name: 'b.txt', kind: 'file' })
    roundTrip(r)
  })

  it('带空格的路径:token 带引号(否则命令行/工具侧会被拆成两段)', () => {
    const p = '/tmp/my docs/note.md'
    expect(fileChip(p).token).toBe(`"${p}"`)
    roundTrip({ kind: 'file', path: p })
  })

  it('**工作区根目录下的裸文件名**也能引用', () => {
    // 旧实现把拖拽载荷拼成文本再解析回来,靠「路径里得有分隔符」认路 —— 云端 Project 根目录的
    // README.md 一个分隔符都没有,于是整条引用悄悄退化成草稿里的一串文本。结构化通道没这问题。
    const r: ChatRef = { kind: 'file', path: 'README.md' }
    expect(refChipOf(r, VAULT)).toEqual({ token: 'README.md', name: 'README.md', kind: 'file' })
    roundTrip(r)
  })

  it('vaultRoot 为空(云端库未就绪)也不崩,仍是合法 wiki token', () => {
    expect(refChipOf({ kind: 'note', path: 'a.md' }, '').token).toBe('[[/a.md|a]]')
  })

  it('文件夹引用保留完整路径并用末级目录作芯片名', () => {
    expect(folderChip('/Users/x/My Project')).toEqual({
      token: '"/Users/x/My Project"', name: 'My Project', kind: 'folder',
    })
  })

  it('View 引用携带稳定 type + 标题，且属性不会突破结构化 token', () => {
    expect(viewChip('canvas&board', '规划 <A> "主视图"')).toEqual({
      token: '<forsion-view type="canvas&amp;board" title="规划 &lt;A&gt; &quot;主视图&quot;" />',
      name: '规划 <A> "主视图"',
      kind: 'view',
    })
  })
})

/** 气泡侧的逆运算(U-11):Composer 把芯片 token 用空格连成正文第一行再接 \n,气泡要能原样拆回来。
 *  所有用例都从**真的芯片构造函数**出发,而不是手写 token —— 构造一改,这里跟着红。 */
describe('splitLeadingRefs', () => {
  const send = (chips: { token: string }[], text: string): string => chips.map((c) => c.token).join(' ') + '\n' + text

  it('全部 token 形态往返:笔记 / 会话 / 本机文件 / 带空格路径 / 文件夹 / View', () => {
    const chips = [
      refChipOf({ kind: 'note', path: '项目/周报.md' }, VAULT),
      refChipOf({ kind: 'session', id: 'abc', title: '昨天那个 bug' }, VAULT),
      refChipOf({ kind: 'file', path: '/tmp/a/b.txt' }, VAULT),
      fileChip('/Users/x/Desktop/Screen Shot 2026-09-25 at 10.00.png'),
      folderChip('/Users/x/My Project'),
      viewChip('canvas&board', '规划 <A> "主视图"'),
      refChipOf({ kind: 'file', path: 'src/app.ts' }, VAULT),
    ]
    const out = splitLeadingRefs(send(chips, '帮我看看'))!
    expect(out).not.toBeNull()
    expect(out.refs.map((r) => r.token)).toEqual(chips.map((c) => c.token))
    expect(out.body).toBe('帮我看看')
    expect(out.refs.map((r) => r.kind)).toEqual(['note', 'session', 'file', 'file', 'file', 'view', 'file'])
    expect(out.refs[1].name).toBe('昨天那个 bug')
    expect(out.refs[3].name).toBe('Screen Shot 2026-09-25 at 10.00.png') // 气泡里不再是带引号的原路径
    expect(out.refs[4].name).toBe('My Project')
    expect(out.refs[5].name).toBe('规划 <A> "主视图"')
    expect(out.refs[0].wiki).toBe(`${VAULT}/项目/周报.md|周报`)
  })

  it('引用 + 引语 + 正文:正文原样保留(多行、> 引用块都不动)', () => {
    const c = fileChip('/tmp/my docs/a.md')
    expect(splitLeadingRefs(`${c.token}\n> 上文\n\n问题一\n问题二`)).toEqual({
      refs: [{ token: c.token, name: 'a.md', kind: 'file' }], body: '> 上文\n\n问题一\n问题二',
    })
  })

  it('只发芯片没写字:有无结尾换行都拆,正文为空', () => {
    const c = refChipOf({ kind: 'session', id: 's1', title: 'T' }, VAULT)
    expect(splitLeadingRefs(`${c.token}\n`)?.body).toBe('')
    expect(splitLeadingRefs(c.token)?.refs).toHaveLength(1)
  })

  it('负例:普通消息一律不拆(宁可原样显示也不吃掉用户的话)', () => {
    for (const text of [
      '你好\n第二行',
      '/refine\n复盘一下',                 // 斜杠命令不是路径
      'and/or 这个怎么选\n…',              // 句子
      'and/or\n下一行',                   // 单段无扩展名的相对路径不认
      '"hello world"\n引号里是句子',        // 引号里没有分隔符
      'https://example.com/a.html\n看看',  // URL
      '/tmp/a.txt  双空格\n',              // token 之间不是单空格
      '[[笔记]] 后面跟了字\n',              // 第一行混了普通文字
      '/Users/x/a.txt',                    // 单独一个裸路径、无换行:多半是用户自己打的
      '',
    ]) expect(splitLeadingRefs(text), text).toBeNull()
  })
})
