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
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', src)(mod, mod.exports)
const { deriveIsland } = mod.exports

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

check('8 都没有待办 → 最近开跑的占岛', () => {
  const r = deriveIsland({ a: 'r1', b: 'r2', c: 'r3' }, {}, sessions, since({ a: 3, b: 7, c: 5 }), tr)
  assert.equal(r.sessionId, 'b')
  assert.equal(r.more, 2)
})

if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1) }
console.log('\nall passed')
