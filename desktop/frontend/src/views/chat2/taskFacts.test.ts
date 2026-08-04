import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types'
import { hasFacts, summarizeTask } from './taskFacts'

const msg = (p: Partial<UiMessage>): UiMessage =>
  ({ id: p.id || 'm', role: 'assistant', content: '', timestamp: 0, ...p }) as UiMessage

describe('summarizeTask', () => {
  it('待批准时主状态压过「正在运行」', () => {
    const f = summarizeTask([msg({ approvals: [{ approvalId: 'a', runId: 'r', name: 'run_bash', preview: '', status: 'pending' }] })], true)
    expect(f.state).toBe('attention')
    expect(f.attention).toHaveLength(1)
  })

  it('已处理的审批/询问不再占位', () => {
    const f = summarizeTask([msg({
      approvals: [{ approvalId: 'a', runId: 'r', name: 'x', preview: '', status: 'approved' }],
      inquiries: [{ inquiryId: 'i', runId: 'r', question: 'q', options: [], status: 'answered' }],
    })], false)
    expect(f.attention).toEqual([])
  })

  it('todo 整单替换,后来者覆盖', () => {
    const f = summarizeTask([
      msg({ id: '1', todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }),
      msg({ id: '2', todos: [{ content: 'a', status: 'completed' }] }),
    ], false)
    expect(f.todos).toEqual([{ content: 'a', status: 'completed' }])
  })

  const tool = (name: string, args: any, extra: any = {}) =>
    ({ id: name + JSON.stringify(args), name, arguments: JSON.stringify(args), done: true, ...extra })

  describe('来源', () => {
    it('读文件/列目录/搜索/取网页各成一类,网页显示域名', () => {
      const f = summarizeTask([msg({
        toolEvents: [
          tool('read_file', { path: '/w/a.md' }),
          tool('list_dir', { path: '/w/src' }),
          tool('web_search', { query: 'codex pinned summary' }),
          tool('web_fetch', { url: 'https://www.example.com/a/b?x=1' }),
        ],
      })], false)
      // 最近使用的排最上面 → 和调用顺序相反
      expect(f.sources.map((s) => [s.kind, s.label])).toEqual([
        ['web', 'example.com'], ['search', 'codex pinned summary'], ['dir', 'src'], ['file', 'a.md'],
      ])
    })

    it('同一来源多次访问只占一行,次数累加', () => {
      const f = summarizeTask([msg({
        toolEvents: [tool('read_file', { path: '/w/a.md' }), tool('read_file', { path: '/w/a.md' }, { id: 'x2' })],
      })], false)
      expect(f.sources).toHaveLength(1)
      expect(f.sources[0].hits).toBe(2)
    })

    it('重复命中按「最近使用」顶回最上面,不是停在首次出现的位置', () => {
      const f = summarizeTask([msg({
        toolEvents: [
          tool('read_file', { path: '/w/a.md' }),
          tool('read_file', { path: '/w/b.md' }),
          tool('read_file', { path: '/w/a.md' }, { id: 'a2' }), // a 又用了一次
        ],
      })], false)
      expect(f.sources.map((s) => s.label)).toEqual(['a.md', 'b.md'])
      expect(f.sources[0].hits).toBe(2)
    })

    it('⚠️失败/未完成的调用不算来源(「试过」≠「采信了」)', () => {
      const f = summarizeTask([msg({
        toolEvents: [
          tool('web_fetch', { url: 'https://bad.example/x' }, { isError: true }),
          tool('read_file', { path: '/w/pending.md' }, { done: false }),
        ],
      })], false)
      expect(f.sources).toEqual([])
    })

    it('写/改/执行类不是来源', () => {
      const f = summarizeTask([msg({
        toolEvents: [tool('write_file', { path: '/w/out.md' }), tool('run_bash', { command: 'ls' })],
      })], false)
      expect(f.sources).toEqual([])
    })
  })

  it('产物按 path 归并,同一文件只一行', () => {
    const f = summarizeTask([
      msg({ id: '1', displayFiles: [{ name: '旧名', path: '/w/a.md' }] }),
      msg({ id: '2', displayFiles: [{ name: '新名', path: '/w/a.md' }, { name: 'b.png', path: '/w/b.png' }] }),
    ], false)
    expect(f.outputs.map((o) => o.name)).toEqual(['b.png', '新名']) // 最近产出在前
  })

  describe('产物', () => {
    it('写盘工具改过的文件也算产物,不必 agent 主动 display_file', () => {
      const f = summarizeTask([msg({
        toolEvents: [
          tool('write_file', { path: '/w/new.ts', content: 'x' }),
          tool('edit_file', { path: '/w/old.ts', old_string: 'a', new_string: 'b' }),
          tool('multi_edit', { path: '/w/multi.ts', edits: [] }),
        ],
      })], false)
      expect(f.outputs.map((o) => o.path)).toEqual(['/w/multi.ts', '/w/old.ts', '/w/new.ts'])
      expect(f.outputs.at(-1)!.name).toBe('new.ts')
    })

    it('再写一次同一文件会顶回最上面(值仍取更权威的那条)', () => {
      const f = summarizeTask([msg({
        toolEvents: [
          tool('write_file', { path: '/w/a.ts' }),
          tool('write_file', { path: '/w/b.ts' }),
          tool('write_file', { path: '/w/a.ts' }, { id: 'a2' }),
        ],
      })], false)
      expect(f.outputs.map((o) => o.path)).toEqual(['/w/a.ts', '/w/b.ts'])
    })

    it('apply_patch 从 patch 正文里取路径,Delete 不算产物', () => {
      const patch = '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: sub/b.ts\n x\n*** Delete File: gone.ts\n*** End Patch'
      const f = summarizeTask([msg({ toolEvents: [tool('apply_patch', { patch })] })], false, '/w')
      expect(f.outputs.map((o) => o.path)).toEqual(['/w/sub/b.ts', '/w/a.ts'])
    })

    it('相对路径拼 cwd,和 display_file 的绝对路径归并成一行', () => {
      const f = summarizeTask([
        msg({ id: '1', displayFiles: [{ name: 'a.md', path: '/w/a.md', mime: 'text/markdown' }] }),
        msg({ id: '2', toolEvents: [tool('write_file', { path: 'a.md', content: 'x' })] }),
      ], false, '/w')
      expect(f.outputs).toHaveLength(1)
      expect(f.outputs[0].mime).toBe('text/markdown') // display_file 那条更权威,不被写盘条覆盖
    })

    it('失败或没跑完的写不算产物', () => {
      const f = summarizeTask([msg({
        toolEvents: [
          tool('write_file', { path: '/w/fail.ts' }, { isError: true }),
          tool('write_file', { path: '/w/pending.ts' }, { done: false }),
        ],
      })], false)
      expect(f.outputs).toEqual([])
    })

    it('脚本造出来的文件覆盖不到(已知天花板:参数里没有路径)', () => {
      const f = summarizeTask([msg({
        toolEvents: [tool('run_python', { code: "open('/w/made.csv','w').write('x')" })],
      })], false)
      expect(f.outputs).toEqual([])
    })
  })

  it('todo_write([]) 是清空清单,不是「没发生」', () => {
    const f = summarizeTask([
      msg({ id: '1', todos: [{ content: 'a', status: 'pending' }] }),
      msg({ id: '2', todos: [] }),
    ], false)
    expect(f.todos).toEqual([])
  })

  it('上一轮摁停残留的未结束工具不带进新一轮', () => {
    const f = summarizeTask([
      msg({ id: '1', role: 'user', timestamp: 1 }),
      msg({ id: '2', status: 'stopped', toolEvents: [{ id: 't1', name: 'run_bash', done: false }] }),
      msg({ id: '3', role: 'user', timestamp: 2 }),
      msg({ id: '4', status: 'streaming' }), // 新一轮刚起步,还没发工具
    ], true)
    expect(f.action).toBeNull()
  })

  it('用户摁停不算「已完成」', () => {
    expect(summarizeTask([msg({ status: 'stopped' })], false).state).toBe('stopped')
  })

  it('当前动作只取未结束的工具;不在跑就没有', () => {
    const ms = [msg({ toolEvents: [{ id: 't1', name: 'read_file', done: true }, { id: 't2', name: 'run_bash', done: false }] })]
    expect(summarizeTask(ms, true).action?.id).toBe('t2')
    expect(summarizeTask(ms, false).action).toBeNull()
  })

  it('后一轮成功即清掉上一轮的错误', () => {
    const f = summarizeTask([msg({ id: '1', status: 'error', error: '炸了' }), msg({ id: '2', status: 'done' })], false)
    expect(f.error).toBeNull()
    expect(f.state).toBe('done')
  })

  it('空会话不出卡;有一条消息就出', () => {
    expect(hasFacts(summarizeTask([], false))).toBe(false)
    expect(hasFacts(summarizeTask([msg({ role: 'user', timestamp: 1 }), msg({ id: '2', status: 'done' })], false))).toBe(true)
  })

  it('失败但没带原因(error 为空串)仍算失败', () => {
    const f = summarizeTask([msg({ status: 'error' })], false)
    expect(f.error).toBe('')
    expect(f.state).toBe('error')
  })

  it('startedAt = 最后一条用户消息', () => {
    expect(summarizeTask([msg({ role: 'user', timestamp: 100 }), msg({ id: '2', role: 'user', timestamp: 300 })], true).startedAt).toBe(300)
  })
})
