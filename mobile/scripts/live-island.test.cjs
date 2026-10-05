/**
 * 灵动岛派生逻辑单测 —— `npm run test:liveisland`(mobile 目录,不用先 build)。
 * 原生那半(通知能否被系统推广上岛)只能真机验;这里钉住「岛上该显示什么、哪个会话占位」。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild') // ponytail: 借 vite 的传递依赖(同 attachment-paths.test.cjs)

const src = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/liveIslandDerive.ts')],
  bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  alias: { '@': path.resolve(__dirname, '../../desktop/frontend/src') }, // 同 vite.config 的 '@' = 桌面渲染层
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', src)(mod, mod.exports)
const { deriveIsland, shadeAnswer } = mod.exports

const tr = (k, v) => (v ? `${k}${JSON.stringify(v)}` : k)
const since = (t) => (sid) => t[sid] ?? 0
const sessions = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }, { id: 'c', title: null }]
const asst = (extra) => ({ id: 'm', role: 'assistant', content: '', status: 'streaming', timestamp: 0, ...extra })

const fails = []
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); fails.push(name) }
}

check('1 没有在跑的 run → 不上岛', () => {
  assert.equal(deriveIsland({}, {}, sessions, since({}), tr), null)
})

check('2 刚开跑还没消息 → 思考中;胶囊留空给计时器;标题取会话名', () => {
  assert.deepEqual(deriveIsland({ a: 'r1' }, {}, sessions, since({ a: 5 }), tr),
    { sessionId: 'a', title: 'Alpha', text: 'island.thinking', chip: '', since: 5, more: 0 })
})

check('3 正文在流 → 正在回复;无名会话落 untitled', () => {
  const r = deriveIsland({ c: 'r1' }, { c: [asst({ content: 'hi' })] }, sessions, since({}), tr)
  assert.equal(r.text, 'island.writing')
  assert.equal(r.title, 'island.untitled')
})

check('4 取最后一条助手消息里最后一个未完成的工具(并行工具取最新起的那个)', () => {
  const m = asst({ toolEvents: [{ id: '1', name: 'read_file', done: true }, { id: '2', name: 'grep', done: false }, { id: '3', name: 'bash', done: false }] })
  const r = deriveIsland({ a: 'r1' }, { a: [asst({ toolEvents: [{ id: 'x', name: 'old', done: false }] }), { id: 'u', role: 'user', content: '', timestamp: 0 }, m] }, sessions, since({}), tr)
  assert.equal(r.text, 'island.tool{"tool":"bash"}')
})

check('5 待审批 → 文案带工具名 + 胶囊短字;压过更晚开跑的会话;more 计其余', () => {
  const r = deriveIsland(
    { a: 'r1', b: 'r2' },
    { a: [asst({ approvals: [{ approvalId: 'p', runId: 'r1', name: 'bash', preview: '', status: 'pending' }] })], b: [asst({ content: 'x' })] },
    sessions, since({ a: 1, b: 9 }), tr)
  assert.equal(r.sessionId, 'a')
  assert.equal(r.text, 'island.approval{"tool":"bash"}')
  assert.equal(r.chip, 'island.chipApproval')
  assert.equal(r.more, 1)
})

check('6 待回答同属「要你动手」', () => {
  const r = deriveIsland({ a: 'r1' }, { a: [asst({ inquiries: [{ inquiryId: 'q', runId: 'r1', question: '?', options: [], status: 'pending' }] })] }, sessions, since({}), tr)
  assert.equal(r.text, 'island.inquiry')
  assert.equal(r.chip, 'island.chipInquiry')
})

check('7 审批已批完不再算待办,回落到工具/正文', () => {
  const r = deriveIsland({ a: 'r1' }, { a: [asst({ content: 'ok', approvals: [{ approvalId: 'p', runId: 'r1', name: 'bash', preview: '', status: 'approved' }] })] }, sessions, since({}), tr)
  assert.equal(r.text, 'island.writing')
  assert.equal(r.chip, '')
})

check('7b 待批审批挂在更早的段上(run 往后跑切出了新段)照样上岛', () => {
  const early = { ...asst({ approvals: [{ approvalId: 'p', runId: 'r1', name: 'bash', preview: '', status: 'pending' }] }), id: 'm0', status: 'done' }
  const r = deriveIsland({ a: 'r1' }, { a: [early, asst({ content: 'still working' })] }, sessions, since({}), tr)
  assert.equal(r.text, 'island.approval{"tool":"bash"}')
  assert.equal(r.chip, 'island.chipApproval')
})

check('7c 待答的提问挂在更早的段上,同样上岛(与输入框上方的托盘同源)', () => {
  const early = { ...asst({ inquiries: [{ inquiryId: 'q', runId: 'r1', question: '?', options: [], status: 'pending' }] }), id: 'm0', status: 'done' }
  const r = deriveIsland({ a: 'r1' }, { a: [early, asst({ content: 'still working' })] }, sessions, since({}), tr)
  assert.equal(r.text, 'island.inquiry')
  assert.equal(r.chip, 'island.chipInquiry')
})

check('8 都没有待办 → 最近开跑的占岛', () => {
  const r = deriveIsland({ a: 'r1', b: 'r2', c: 'r3' }, {}, sessions, since({ a: 3, b: 7, c: 5 }), tr)
  assert.equal(r.sessionId, 'b')
  assert.equal(r.more, 2)
})

// 通知上的「拒绝 / 允许」(shadeAsk):按钮上有什么,点下去才认什么 —— 岛与兑现共用这一个判据。
const pendingApproval = (extra) => asst({ id: 'm7', approvals: [{ approvalId: 'p', runId: 'r1', name: 'run_bash', preview: '$ npm test', status: 'pending', reason: { kind: 'mode' }, ...extra }] })
const askOf = (extra) => deriveIsland({ a: 'r1' }, { a: [pendingApproval(extra)] }, sessions, since({}), tr).ask
// 通知按钮送回来的作答(shadeAnswer):只认还在待批、且这张审批此刻还给得出的那个动作。
const tap = (action, extra, ids = {}) => shadeAnswer({ messageId: 'm7', approvalId: 'p', action, ...ids }, [pendingApproval(extra)])

check('9 普通审批 + 命令短到能整段显示 → 通知上给「允许」,并带上那条命令;custom-ask、后台命令同', () => {
  assert.deepEqual(askOf({}), { messageId: 'm7', approvalId: 'p', allow: true, detail: '$ npm test' })
  assert.equal(askOf({ name: 'run_background', preview: 'bg$ npm run dev' }).allow, true)
  assert.deepEqual(askOf({ reason: { kind: 'custom-ask', rule: 'bash(npm *)' }, preview: '  a\nb\nc  ' }), { messageId: 'm7', approvalId: 'p', allow: true, detail: 'a\nb\nc' })
  assert.equal(askOf({ preview: 'x'.repeat(120) }).allow, true)
})

check('10 内容看不全(太长 / 太多行 / 没有内容)→ 只给「拒绝」,内容也不带', () => {
  for (const preview of ['x'.repeat(121), 'a\nb\nc\nd', '', '   '])
    assert.deepEqual(askOf({ preview }), { messageId: 'm7', approvalId: 'p', allow: false }, JSON.stringify(preview).slice(0, 20))
})

check('11 越界写入 / 受保护路径 / 设备操控 / 没写原因 / 只能在执行设备上批 → 只给「拒绝」', () => {
  for (const extra of [{ reason: { kind: 'escalate' } }, { reason: { kind: 'protected' } }, { reason: { kind: 'control' } }, { reason: undefined }, { localOnly: true }])
    assert.deepEqual(askOf(extra), { messageId: 'm7', approvalId: 'p', allow: false }, JSON.stringify(extra))
})

check('11b 预览只是摘要的工具(写文件 / 改文件 / 补丁)和表外的工具 → 只给「拒绝」:改了什么通知上看不到', () => {
  const summaries = [['write_file', 'write src/boot.sh (2200 chars)'], ['edit_file', 'edit src/boot.sh'], ['multi_edit', 'multi_edit src/boot.sh (3 edits)'], ['apply_patch', 'apply_patch (2 file change(s))'], ['mcp__files__delete', 'delete notes.md'], ['bash', '$ npm test']]
  for (const [name, preview] of summaries) {
    assert.deepEqual(askOf({ name, preview }), { messageId: 'm7', approvalId: 'p', allow: false }, name)
    assert.equal(tap('approve', { name, preview }), null, name)
    assert.deepEqual(tap('reject', { name, preview }), { messageId: 'm7', approvalId: 'p', action: 'reject' }, name)
  }
})

check('12 远程来源的审批、提问、没有待办 → 通知上不放按钮(结果里没有 ask 这个键)', () => {
  assert.equal('ask' in deriveIsland({ a: 'r1' }, { a: [pendingApproval({ remote: { via: 'tunnel' } })] }, sessions, since({}), tr), false)
  assert.equal('ask' in deriveIsland({ a: 'r1' }, { a: [asst({ inquiries: [{ inquiryId: 'q', runId: 'r1', question: '?', options: [], status: 'pending' }] })] }, sessions, since({}), tr), false)
  assert.equal('ask' in deriveIsland({ a: 'r1' }, { a: [asst({ content: 'x' })] }, sessions, since({}), tr), false)
})

check('13 岛让给更要紧的会话时,按钮跟着岛上那张审批走(不是别的会话的)', () => {
  const r = deriveIsland(
    { a: 'r1', b: 'r2' },
    { a: [asst({ content: 'x' })], b: [{ ...pendingApproval({ approvalId: 'pb' }), id: 'mb' }] },
    sessions, since({ a: 9, b: 1 }), tr)
  assert.equal(r.sessionId, 'b')
  assert.deepEqual(r.ask, { messageId: 'mb', approvalId: 'pb', allow: true, detail: '$ npm test' })
})


check('14 按钮上有的才认:普通短请求认「允许 / 拒绝」;「允许」只变成 approve', () => {
  assert.deepEqual(tap('approve', {}), { messageId: 'm7', approvalId: 'p', action: 'approve' })
  assert.deepEqual(tap('reject', {}), { messageId: 'm7', approvalId: 'p', action: 'reject' })
  for (const action of ['approve_always', 'APPROVE', '', undefined, null, 1, { toString: () => 'approve' }]) assert.equal(tap(action, {}), null, String(action))
})

check('15 通知上没给「允许」的,送来 approve 也不认(看不全 / 越界 / 受保护 / 只能本机批);「拒绝」照认', () => {
  for (const extra of [{ preview: 'x'.repeat(121) }, { preview: '' }, { reason: { kind: 'escalate' } }, { reason: { kind: 'protected' } }, { reason: { kind: 'control' } }, { reason: undefined }, { localOnly: true }]) {
    assert.equal(tap('approve', extra), null, JSON.stringify(extra).slice(0, 40))
    assert.deepEqual(tap('reject', extra), { messageId: 'm7', approvalId: 'p', action: 'reject' }, JSON.stringify(extra).slice(0, 40))
  }
})

check('16 远程来源的审批、已经答过的、对不上号的(别的审批 / 别的消息 / 空会话)→ 一律不认', () => {
  for (const action of ['approve', 'reject']) {
    assert.equal(tap(action, { remote: { via: 'tunnel' } }), null)
    for (const status of ['approved', 'rejected', 'expired']) assert.equal(tap(action, { status }), null, status)
    assert.equal(tap(action, {}, { approvalId: 'other' }), null)
    assert.equal(tap(action, {}, { messageId: 'other' }), null)
    assert.equal(tap(action, {}, { approvalId: undefined }), null)
    assert.equal(shadeAnswer({ messageId: 'm7', approvalId: 'p', action }, undefined), null)
    assert.equal(shadeAnswer({ messageId: 'm7', approvalId: 'p', action }, []), null)
  }
})

check('17 提问不是审批:拿提问的 id 来「允许」不认', () => {
  const m = asst({ id: 'm7', inquiries: [{ inquiryId: 'p', runId: 'r1', question: '?', options: [], status: 'pending' }] })
  assert.equal(shadeAnswer({ messageId: 'm7', approvalId: 'p', action: 'approve' }, [m]), null)
  assert.equal(shadeAnswer({ messageId: 'm7', approvalId: 'p', action: 'reject' }, [m]), null)
})

if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1) }
console.log('\nall passed')
