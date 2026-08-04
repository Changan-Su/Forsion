// 宿主同构自检:像 desktop pluginStore.toPlugin 一样 new Function('ctx', src)(mockCtx) 求值 main.js,
// 断言贡献点注册成功。跑法:node check.mjs;非 0 退出即违约。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(ROOT, 'main.js'), 'utf8')
if (/^\s*(import|export)\s/m.test(src)) { console.error('❌ main.js 必须是裸 setup 体,不得有顶层 import/export'); process.exit(1) }

const commands = []
const notifications = []
const ctx = {
  registerCommand: (c) => commands.push(c),
  notify: (m, o) => notifications.push({ m, o }),
}
new Function('ctx', src)(ctx)

if (commands.length !== 1) { console.error(`❌ 应注册恰好 1 条命令,实际 ${commands.length}`); process.exit(1) }
if (!commands[0].id.startsWith('sample-bundle')) { console.error(`❌ 命令 id "${commands[0].id}" 未带包前缀`); process.exit(1) }
await commands[0].run() // 此 ctx 连 app 都没有:文件面示范必须整体跳过、不得 TypeError
if (notifications.length !== 1) { console.error('❌ 命令执行未产生通知'); process.exit(1) }

// 新宿主(2026-08-03 起):有 ctx.app.workFolder/writeFile → 文件面示范应落 <工作文件夹>/你好.md
const writes = []
const newCommands = []
new Function('ctx', src)({
  registerCommand: (c) => newCommands.push(c),
  notify: () => {},
  app: { notify: () => {}, workFolder: () => '示例捆绑包', writeFile: async (p, t) => writes.push({ p, t }), openFile: () => {} },
})
await newCommands[0].run()
if (writes.length !== 1 || writes[0].p !== '示例捆绑包/你好.md') { console.error(`❌ 文件面示范未按 workFolder 落盘:${JSON.stringify(writes)}`); process.exit(1) }

// 旧宿主兼容:没有可选 ctx.notify 时必须回退 ctx.app.notify(且无 workFolder 时跳过写文件),不得 TypeError
const legacyNotes = []
const legacyCommands = []
new Function('ctx', src)({ registerCommand: (c) => legacyCommands.push(c), app: { notify: (m) => legacyNotes.push(m) } })
await legacyCommands[0].run()
if (legacyNotes.length !== 1) { console.error('❌ 旧宿主(无 ctx.notify)回退失败'); process.exit(1) }
console.log('check ok — 1 cmd 注册(id 带包前缀);无 app 宿主不炸;新宿主 workFolder 落盘;旧宿主 notify 回退通过')
