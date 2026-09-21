// 宿主同构自检:像 desktop pluginStore.toPlugin 一样 new Function('ctx', src)(mockCtx) 求值 main.js,
// 断言贡献点注册成功。跑法:node check.mjs;非 0 退出即违约。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1) }
if (/^\s*(import|export)\s/m.test(src)) fail('main.js 必须是裸 setup 体,不得有顶层 import/export')

// CHANGELOG 顶节版本 = manifest.version(不 bump 市场推不下去更新)
const top = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m)?.[1]
if (top !== manifest.version) fail(`CHANGELOG 顶节 ${top} ≠ manifest.version ${manifest.version}`)

// 宿主渲染进程里有 localStorage,node 没有:装一个内存版(插件设置值就存在 plugin.<id>.<key>)
const store = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
})
const NICK = `plugin.${manifest.id}.nickname`

// ── 1. 无 app 的宿主(有 notify):已填称呼 → 通知一次、文件面示范整体跳过、不得 TypeError
store.set(NICK, '阿青')
const views = []
const commands = []
const notifications = []
new Function('ctx', src)({
  registerCommand: (c) => commands.push(c),
  registerView: (v) => views.push(v),
  registerSetting: () => {},
  notify: (m, o) => notifications.push({ m, o }),
})
if (commands.length !== 1) fail(`应注册恰好 1 条命令,实际 ${commands.length}`)
if (!commands[0].id.startsWith('sample-bundle')) fail(`命令 id "${commands[0].id}" 未带包前缀`)
await commands[0].run()
if (notifications.length !== 1 || !notifications[0].m.includes('阿青')) fail(`命令执行未产生带称呼的通知:${JSON.stringify(notifications)}`)

// ── 2. onboarding.requires 与 registerSetting 对账:闸里点名的 setting key 必须注册过(否则宿主永远判「无法检查」),
//       且其 default 不得是个能用的值(判据是「≠ 默认」)
const settings = []
const newCommands = []
const writes = []
const newNotes = []
const newHostCtx = {
  registerCommand: (c) => newCommands.push(c),
  registerView: () => {},
  registerSetting: (s) => settings.push(s),
  notify: (m) => newNotes.push(m),
  getLocale: () => 'zh',
  app: { notify: () => {}, workFolder: () => '示例捆绑包', writeFile: async (p, t) => writes.push({ p, t }), openFile: () => {} },
}
new Function('ctx', src)(newHostCtx)
const reqKeys = (manifest.onboarding?.requires ?? []).filter((r) => r.kind === 'setting').map((r) => r.key)
if (!reqKeys.length) fail('manifest.onboarding.requires 应至少有一条 setting 类示范')
for (const key of reqKeys) {
  const def = settings.find((s) => s.key === key)
  if (!def) fail(`requires 点名的 setting "${key}" 没有 registerSetting`)
  if (String(def.default).trim() !== '') fail(`必填设置 "${key}" 的 default 应为空串(判据是「≠ 默认」),实际 ${JSON.stringify(def.default)}`)
}
// onboarding 双语:en.intro 必须有,en.steps 与 steps 按下标对齐(条数相等)
const ob = manifest.onboarding
if (!ob.en?.intro || (ob.en.steps ?? []).length !== (ob.steps ?? []).length) fail('onboarding.en.intro / en.steps 缺失或与 steps 条数不齐')

// ── 3. 新宿主、未填称呼:命令说清缺什么然后停 —— 不写文件
store.delete(NICK)
await newCommands[0].run()
if (writes.length !== 0) fail(`未填称呼时不应落盘:${JSON.stringify(writes)}`)
if (newNotes.length !== 1 || !newNotes[0].includes('称呼')) fail(`未填称呼时应提示去设置里填:${JSON.stringify(newNotes)}`)

// ── 4. 新宿主、填了称呼:文件面示范落 <工作文件夹>/你好.md,正文带称呼
store.set(NICK, '  阿青  ')
await newCommands[0].run()
if (writes.length !== 1 || writes[0].p !== '示例捆绑包/你好.md' || !writes[0].t.includes('你好,阿青\n')) fail(`文件面示范未按 workFolder 落盘或称呼未 trim:${JSON.stringify(writes)}`)

// ── 5. 英文界面:命令标题与提示跟 getLocale 走
const enCommands = []
const enNotes = []
store.delete(NICK)
new Function('ctx', src)({ ...newHostCtx, registerCommand: (c) => enCommands.push(c), notify: (m) => enNotes.push(m), getLocale: () => 'en' })
if (enCommands[0].title !== 'Sample bundle: say hello') fail(`英文命令标题不对:${enCommands[0].title}`)
await enCommands[0].run()
if (!/Your name/.test(enNotes[0] ?? '') || /[一-鿿]/.test(enNotes[0])) fail(`英文界面的未填提示不对:${JSON.stringify(enNotes)}`)
// ⚠ 上面那条只扫「未填称呼」一句。英文里混汉字的常见落点是**成功路径**与 manifest 的 en.steps ——
//   仪器扫不到的地方,违规就会在绿灯下溜过去(2026-09-21 复核实测)。
const enHan = []
for (const s of enNotes) if (/[一-鿿]/.test(s)) enHan.push(s)
const mf = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const en = mf.onboarding?.en ?? {}
for (const s of [en.intro, ...(en.steps ?? []).flatMap((x) => [x?.title, x?.description])]) {
  if (typeof s === 'string' && /[一-鿿]/.test(s)) enHan.push(s)
}
if (enHan.length) fail(`英文文案里混了汉字:${JSON.stringify(enHan)}`)

// ── 6. 旧宿主兼容:没有 ctx.notify / getLocale / registerReadiness 时必须回退 ctx.app.notify(且无 workFolder 时跳过写文件),不得 TypeError
store.set(NICK, '阿青')
const legacyNotes = []
const legacyCommands = []
new Function('ctx', src)({ registerView: () => {}, registerSetting: () => {}, registerCommand: (c) => legacyCommands.push(c), app: { notify: (m) => legacyNotes.push(m) } })
await legacyCommands[0].run()
if (legacyNotes.length !== 1) fail('旧宿主(无 ctx.notify)回退失败')
console.log('check ok — 1 cmd 注册(id 带包前缀);requires 的 setting 已注册且 default 为空;未填称呼不落盘并提示;填了按 workFolder 落盘;中英切换;旧宿主 notify 回退通过')

const mini = JSON.parse(readFileSync(path.join(ROOT, 'spaces/sample-bundle-mini/space.json'), 'utf8')).mini
if (views.length !== 2 || mini.view.type === mini.mainView.type || !views.some((v) => mini.view.type.endsWith(':' + v.id)) || !views.some((v) => mini.mainView.type.endsWith(':' + v.id))) throw new Error('Mini recipe must resolve distinct registered views')
console.log('Mini recipe resolves both dedicated surfaces')
