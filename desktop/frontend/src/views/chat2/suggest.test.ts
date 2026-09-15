import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { splitSuggestions, type FenceKind } from './suggest'

const F = '```'

describe('splitSuggestions', () => {
  it('普通消息原样返回', () => {
    const raw = `这是一段回答。\n\n${F}ts\nconst a = 1\n${F}`
    const r = splitSuggestions(raw)
    expect(r.text).toBe(raw)
    expect(r.items).toEqual([])
  })

  it('摘出建议,正文里不留围栏痕迹', () => {
    const { text, items } = splitSuggestions(
      `那最稳妥的是设两次提醒。\n\n${F}forsion-suggest\n提醒我今天 11:30 准备 12 点的会议\n每周五 17:00 提醒我整理本周笔记\n${F}\n`,
    )
    expect(text).toBe('那最稳妥的是设两次提醒。')
    expect(items).toEqual(['提醒我今天 11:30 准备 12 点的会议', '每周五 17:00 提醒我整理本周笔记'])
  })

  it('模型在讲解这个功能本身 —— 外层围栏里的示例不能变成真芯片,也不能被删掉', () => {
    const raw = `你可以这么写:\n\n\`\`\`\`markdown\n${F}forsion-suggest\n提醒我明天 8 点开会\n${F}\n\`\`\`\`\n`
    const { text, items } = splitSuggestions(raw)
    expect(items).toEqual([])
    expect(text).toContain('forsion-suggest')
    expect(text).toContain('提醒我明天 8 点开会')
  })

  it('四反引号也能收口(CommonMark:收口数 ≥ 开栏数),后面的正文要留住', () => {
    const { text, items } = splitSuggestions(
      `正文\n${F}forsion-suggest\n提醒我明天 8 点开会\n\`\`\`\`\n这句正文必须保留`,
    )
    expect(items).toEqual(['提醒我明天 8 点开会'])
    expect(text).toBe('正文\n这句正文必须保留')
  })

  it('已完成却没收口 = 模型写坏了 → 还回正文,不许吞', () => {
    const raw = `好的。\n${F}forsion-suggest\n提醒我明天 8 点开会\n后面还有正文`
    const { text, items } = splitSuggestions(raw)
    expect(items).toEqual([])
    expect(text).toBe(raw)
  })

  it('流式中还没收口 —— 先藏起来,别让裸围栏闪一下', () => {
    const { text, items } = splitSuggestions(`好的。\n\n${F}forsion-suggest\n提醒我今天 11:3`, { streaming: true })
    expect(text).toBe('好的。')
    expect(items).toEqual([]) // 未收口不出芯片(芯片本来也只在 done 才渲染)
  })

  it('围栏被工具块切成两段 —— 状态续读,建议不泄漏进正文', () => {
    const a = splitSuggestions(`前文\n${F}forsion-suggest\n`, { streaming: true })
    const b = splitSuggestions(`提醒我明天 8 点开会\n${F}\n尾文`, { streaming: true, state: a.state })
    expect(a.text).toBe('前文')
    expect(b.text).toBe('尾文')
    expect(b.items).toEqual(['提醒我明天 8 点开会'])
  })

  it('剥掉项目符号/序号,丢掉过短过长的行,最多 3 条', () => {
    const { items } = splitSuggestions(
      [`${F}forsion-suggest`, '- 每天提醒我喝水', '2. 每周五整理笔记', '继续', '每月底导出账单', 'x'.repeat(81), '每天九点提醒我', F].join('\n'),
    )
    expect(items).toEqual(['每天提醒我喝水', '每周五整理笔记', '每月底导出账单']) // 「继续」太短被挡:不给单词芯片洗成用户指令
  })
})

describe('splitSuggestions × forsion-task 任务卡', () => {
  const card = (body: string): string => `${F}forsion-task\n${body}\n${F}`

  it('头部 key: value + --- + 任务书 → 一张卡;正文里不留围栏', () => {
    const raw = `顺手发现一个问题。\n\n${card('title: 修生图 slug 被当聊天模型\ntldr: grok-imagine 混进了聊天模型选择器\ntrack: false\n---\n在 desktop/frontend/src/… 里,direct provider 把 image 类 slug 也当聊天模型。\n复现:设置 → 模型 → xAI。')}\n`
    const r = splitSuggestions(raw)
    expect(r.text).toBe('顺手发现一个问题。')
    expect(r.items).toEqual([])
    expect(r.tasks).toEqual([{
      title: '修生图 slug 被当聊天模型',
      tldr: 'grok-imagine 混进了聊天模型选择器',
      prompt: '在 desktop/frontend/src/… 里,direct provider 把 image 类 slug 也当聊天模型。\n复现:设置 → 模型 → xAI。',
    }])
  })

  it('track: true 进卡;未知键忽略(扩展契约);没有 --- 时首行当标题、整段当任务书', () => {
    const r1 = splitSuggestions(card('title: 盯着 CI\ntrack: yes\npriority: high\n---\n每天看一眼 build-desktop 的失败率。'))
    expect(r1.tasks[0]).toEqual({ title: '盯着 CI', track: true, prompt: '每天看一眼 build-desktop 的失败率。' })
    const r2 = splitSuggestions(card('整理下载文件夹\n把 ~/Downloads 里超过 30 天的安装包归档。'))
    expect(r2.tasks[0].title).toBe('整理下载文件夹')
    expect(r2.tasks[0].prompt).toBe('整理下载文件夹\n把 ~/Downloads 里超过 30 天的安装包归档。')
  })

  it('缺任务书的坏卡 → 原样还回正文,不吞字;每条消息最多 2 张', () => {
    const bad = splitSuggestions(`说明\n${card('title: 只有标题')}`)
    expect(bad.tasks).toEqual([])
    expect(bad.text).toContain('title: 只有标题')
    const many = splitSuggestions([card('title: a\n---\np1'), card('title: b\n---\np2'), card('title: c\n---\np3')].join('\n'))
    expect(many.tasks.map((c) => c.title)).toEqual(['a', 'b'])
    expect(many.text).toContain('p3') // 第三张超上限:原样还回正文(09-11 起),不再静默消失
    expect(many.text).not.toContain('p2')
  })

  it('芯片与任务卡可同时出现;流式未收口的卡先藏起来;讲解示例(外层四反引号)不成卡', () => {
    const both = splitSuggestions(`${F}forsion-suggest\n提醒我明天 8 点开会\n${F}\n${card('title: t\n---\np')}`)
    expect(both.items).toEqual(['提醒我明天 8 点开会'])
    expect(both.tasks.length).toBe(1)
    const streaming = splitSuggestions(`好的。\n${F}forsion-task\ntitle: t\n---\n还在`, { streaming: true })
    expect(streaming.text).toBe('好的。')
    expect(streaming.tasks).toEqual([])
    const taught = splitSuggestions(`写法:\n\`\`\`\`markdown\n${card('title: t\n---\np')}\n\`\`\`\`\n`)
    expect(taught.tasks).toEqual([])
    expect(taught.text).toContain('forsion-task')
  })

  it('围栏被工具块切成两段 —— 卡片状态续读', () => {
    const a = splitSuggestions(`前文\n${F}forsion-task\ntitle: t\n---\n`, { streaming: true })
    const b = splitSuggestions(`任务书正文\n${F}\n尾文`, { streaming: true, state: a.state })
    expect(a.text).toBe('前文')
    expect(b.text).toBe('尾文')
    expect(b.tasks).toEqual([{ title: 't', prompt: '任务书正文' }])
  })
})

describe('splitSuggestions × 围栏纪律(Codex 09-10 评审补钉)', () => {
  it('~~~ 波浪线外层示例里的 forsion-task 不成卡、不被删(反引号收不了波浪线围栏)', () => {
    const raw = `写法示例:\n~~~markdown\n${F}forsion-task\ntitle: t\n---\np\n${F}\n~~~\n结束`
    const r = splitSuggestions(raw)
    expect(r.tasks).toEqual([])
    expect(r.items).toEqual([])
    expect(r.text).toContain('forsion-task')
    expect(r.text).toContain('结束')
  })
  it('波浪线围栏开的 forsion-task 也认,且只能用波浪线收口', () => {
    const r = splitSuggestions(`~~~forsion-task\ntitle: t\n---\np\n~~~\n尾`)
    expect(r.tasks).toEqual([{ title: 't', prompt: 'p' }])
    expect(r.text).toBe('尾')
    const notClosed = splitSuggestions(`~~~forsion-task\ntitle: t\n---\np\n${F}\n尾`)
    expect(notClosed.tasks).toEqual([]) // 反引号收不了 → 未收口 → 还回正文
    expect(notClosed.text).toContain('title: t')
  })
  it('写坏的卡按真实收口行还回正文(四反引号收口不改写成三个)', () => {
    const r = splitSuggestions(`x\n${F}forsion-task\ntitle: 只有标题\n\`\`\`\`\ny`)
    expect(r.tasks).toEqual([])
    expect(r.text).toBe(`x\n${F}forsion-task\ntitle: 只有标题\n\`\`\`\`\ny`)
  })
  it('续读状态不可变:第二段解析不改第一段返回的 state', () => {
    const a = splitSuggestions(`${F}forsion-task\ntitle: t\n---\n`, { streaming: true })
    const snapshot = JSON.stringify(a.state)
    splitSuggestions(`p\n${F}`, { streaming: true, state: a.state })
    expect(JSON.stringify(a.state)).toBe(snapshot)
  })
  it('消息已完成但当前只是靠前的一段(streaming:true 由调用方标)→ 未收口先藏,尾段才还回', () => {
    const a = splitSuggestions(`前文\n${F}forsion-task\ntitle: t\n---\n`, { streaming: true })
    expect(a.text).toBe('前文')
    const b = splitSuggestions(`p`, { streaming: false, state: a.state })
    expect(b.text).toContain('title: t') // 尾段没收口 → 还回
    expect(b.tasks).toEqual([])
  })
})

describe('forsion-approval(收件箱审批卡,2026-09-11)', () => {
  it('JSON 围栏 → 摘出 id,正文不留痕', () => {
    const r = splitSuggestions(`write_file · write /tmp/x.md\n\n${F}forsion-approval\n{"id":"3f0c1a2b-1111-4222-8333-944455556666"}\n${F}`, { kinds: ['task', 'approval'] })
    expect(r.approvals).toEqual(['3f0c1a2b-1111-4222-8333-944455556666'])
    expect(r.text).toBe('write_file · write /tmp/x.md')
  })

  it('`id: …` 行与裸 id 也认;同 id 去重;写坏的(空 / 非法字符 / 坏 JSON)整块还回正文', () => {
    const K = { kinds: ['task', 'approval'] as const }
    expect(splitSuggestions(`${F}forsion-approval\nid: apv-1\n${F}`, { kinds: [...K.kinds] }).approvals).toEqual(['apv-1'])
    expect(splitSuggestions(`${F}forsion-approval\napv-1\n${F}\n\n${F}forsion-approval\napv-1\n${F}`, { kinds: [...K.kinds] }).approvals).toEqual(['apv-1'])
    const bad = splitSuggestions(`${F}forsion-approval\n{"id":"../x"}\n${F}`, { kinds: [...K.kinds] })
    expect(bad.approvals).toEqual([])
    expect(bad.text).toContain('forsion-approval')
    const broken = splitSuggestions(`${F}forsion-approval\n{"id":\n${F}`, { kinds: [...K.kinds] })
    expect(broken.approvals).toEqual([])
    expect(broken.text).toContain('{"id":')
  })

  it('讲解用的外层围栏里的示例不是真审批卡', () => {
    const r = splitSuggestions(`写法:\n\n\`\`\`\`markdown\n${F}forsion-approval\n{"id":"apv-1"}\n${F}\n\`\`\`\`\n`, { kinds: ['task', 'approval'] })
    expect(r.approvals).toEqual([])
    expect(r.text).toContain('apv-1')
  })

  it('kinds 只认 task/approval(收件箱):suggest 围栏原样留在正文,任务卡照摘', () => {
    const raw = `正文。\n\n${F}forsion-suggest\n提醒我今天 11:30 准备会议\n${F}\n\n${F}forsion-task\ntitle: 修 slug\n---\n任务书正文。\n${F}`
    const r = splitSuggestions(raw, { kinds: ['task', 'approval'] })
    expect(r.items).toEqual([])
    expect(r.text).toContain('forsion-suggest')
    expect(r.text).toContain('提醒我今天 11:30 准备会议')
    expect(r.tasks.map((c) => c.title)).toEqual(['修 slug'])
    expect(r.text).not.toContain('forsion-task')
  })
})

describe('缺省种类与上限(Codex 09-11)', () => {
  it('聊天缺省不认 approval:围栏原样留在正文,不会被悄悄吃掉', () => {
    const r = splitSuggestions(`正文。\n\n${F}forsion-approval\n{"id":"apv-1"}\n${F}`)
    expect(r.approvals).toEqual([])
    expect(r.text).toContain('forsion-approval')
    expect(r.text).toContain('apv-1')
  })

  it('超过上限的合法任务卡 / 审批还回正文,绝不静默消失', () => {
    const card = (n: number) => `${F}forsion-task\ntitle: 卡 ${n}\n---\n任务书 ${n}。\n${F}`
    const r = splitSuggestions(`${card(1)}\n\n${card(2)}\n\n${card(3)}`)
    expect(r.tasks.map((c) => c.title)).toEqual(['卡 1', '卡 2'])
    expect(r.text).toContain('任务书 3。')
    expect(r.text).not.toContain('任务书 2。')
    const a = (id: string) => `${F}forsion-approval\n{"id":"${id}"}\n${F}`
    const q = splitSuggestions(`${a('a1')}\n\n${a('a2')}\n\n${a('a3')}`, { kinds: ['task', 'approval'] })
    expect(q.approvals).toEqual(['a1', 'a2'])
    expect(q.text).toContain('"id":"a3"')
  })
})

describe('任务卡 todo 头(Muse TODO 的收件箱投影,2026-09-11)', () => {
  // 引擎单测(tangu-agent/test/museTodo.test.ts)生成 / 比对的同一份产物:键名一漂,两边一起红
  const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../../../tangu-agent/test/fixtures/${name}`, import.meta.url).href), 'utf8')
  const inbox = { kinds: ['task', 'approval'] as FenceKind[], todo: true }

  it('引擎夹具:正文 = detail(不留围栏),一张卡带 todo id,任务书 = 标题 + detail', () => {
    const r = splitSuggestions(fixture('muse-todo-mail.md'), inbox)
    expect(r.tasks).toHaveLength(1)
    expect(r.tasks[0]).toMatchObject({ title: '恢复并验收鹈鹕骑自行车网页动画', todo: 'todo-fixture-1' })
    expect(r.tasks[0].prompt.startsWith('恢复并验收鹈鹕骑自行车网页动画\n\n上次生成 run 失败')).toBe(true)
    expect(r.text).toContain('pelican-cycling.html')
    expect(r.text).not.toMatch(/forsion-task|todo-fixture-1/)
  })

  it('detail 末尾代码块没收口(引擎补了收口):卡照样摘出,代码留在正文', () => {
    const r = splitSuggestions(fixture('muse-todo-mail-openfence.md'), inbox)
    expect(r.tasks).toHaveLength(1)
    expect(r.tasks[0].todo).toBe('todo-fixture-2')
    expect(r.text).toContain('exportAll')
    expect(r.text).not.toMatch(/forsion-task|todo-fixture-2/)
  })

  it('todo 语义要调用方显式开:缺省(聊天 / 非 Muse 的信)只当普通任务卡', () => {
    const r = splitSuggestions(fixture('muse-todo-mail.md'), { kinds: ['task', 'approval'] })
    expect(r.tasks).toHaveLength(1)
    expect(r.tasks[0].todo).toBeUndefined()
  })

  it('非法 todo id 只丢这个键,卡照出', () => {
    const r = splitSuggestions(`${F}forsion-task\ntitle: t\ntodo: ../x y\n---\ndo it\n${F}`, { todo: true })
    expect(r.tasks).toHaveLength(1)
    expect(r.tasks[0].todo).toBeUndefined()
  })
})
