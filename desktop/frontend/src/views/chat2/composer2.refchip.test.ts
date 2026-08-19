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
