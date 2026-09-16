/**
 * attachmentPaths 单测(无 process 沙箱)—— `npm run test:attachpaths`(mobile 目录,不用先 build)。
 *
 * 起因(2026-09-16):移动端本地库的 saveAttachment 一律抛 `ReferenceError: process is not defined` ——
 * attachmentPaths 把 vault 相对路径喂给 path-browserify.relative,它对相对路径回落 process.cwd(),
 * 而 Capacitor WebView / 浏览器里没有 process。
 *
 * ⚠️ 别改成 vitest:它跑在 Node 里,process 恒在,修前的代码照样绿(假绿)。这里按浏览器打包,
 * 丢进 vm 的空上下文(没有 process/require/Buffer,与 WebView 同)求值;沙箱先过一道负对照
 * (裸调 path-browserify 相对路径必须在里面抛),证明「没有 process」是真的。
 * 语义对照 = desktop 的 node:path 版(electron/amadeus/fs/attachmentPaths.ts)逐格比对。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild') // ponytail: 借 vite 的传递依赖;哪天 vite 不再带 esbuild,补成 devDependency

const root = path.resolve(__dirname, '..')
const bundle = (opts) =>
  buildSync({ bundle: true, write: false, logLevel: 'silent', absWorkingDir: root, ...opts }).outputFiles[0].text
/** 按浏览器打包 → 空 vm 上下文求值(模拟 WebView),返回导出。 */
const inSandbox = (opts) => vm.runInNewContext(`${bundle({ platform: 'browser', format: 'iife', globalName: 'G', ...opts })};G`, {})

const fails = []
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); fails.push(name) }
}

check('0 沙箱负对照:裸 path-browserify.relative 相对路径在沙箱里必抛(证明沙箱确实没有 process)', () => {
  const bare = inSandbox({ stdin: { contents: "import p from 'path-browserify'; export const rel = (a, b) => p.relative(a, b)", resolveDir: root } })
  assert.equal(vm.runInNewContext('typeof process', {}), 'undefined')
  assert.throws(() => bare.rel('Notes', 'assets/p.png'), /process is not defined/)
})

const { attachmentPaths } = inSandbox({ entryPoints: ['src/amadeus/attachmentPaths.ts'] })
// 跨 realm 的对象原型不同,deepStrictEqual 会判不等 —— 展开成本 realm 的普通对象再比。
const mobile = (...a) => ({ ...attachmentPaths(...a) })
const r = (destDirRel, fileVaultRel, pageRel) => ({ destDirRel, fileVaultRel, pageRel })

const CASES = [
  // [说明, pagePath, base, opts, 期望]
  ['attachments 模式 → 笔记旁 attachments/', 'Notes/ideas.md', 'p.png', { mode: 'attachments', folder: 'assets' }, r('Notes/attachments', 'Notes/attachments/p.png', 'attachments/p.png')],
  ['attachments 模式 · 库根笔记', 'ideas.md', 'p.png', { mode: 'attachments', folder: '' }, r('attachments', 'attachments/p.png', 'attachments/p.png')],
  ['same 模式 → 笔记同目录', 'Notes/ideas.md', 'p.png', { mode: 'same', folder: 'assets' }, r('Notes', 'Notes/p.png', 'p.png')],
  ['same 模式 · 库根笔记', 'ideas.md', 'p.png', { mode: 'same', folder: 'assets' }, r('', 'p.png', 'p.png')],
  ['vault 模式 → 固定目录,页相对路径跳出笔记目录', 'Notes/ideas.md', 'p.png', { mode: 'vault', folder: '/assets/' }, r('assets', 'assets/p.png', '../assets/p.png')],
  ['嵌套页 · attachments', 'a/b/c/deep.md', 'p.png', { mode: 'attachments', folder: '' }, r('a/b/c/attachments', 'a/b/c/attachments/p.png', 'attachments/p.png')],
  ['嵌套页 · same', 'a/b/c/deep.md', 'p.png', { mode: 'same', folder: '' }, r('a/b/c', 'a/b/c/p.png', 'p.png')],
  ['嵌套页 · vault 兄弟目录', 'a/b/c/deep.md', 'p.png', { mode: 'vault', folder: 'a/x' }, r('a/x', 'a/x/p.png', '../../x/p.png')],
  ['嵌套页 · vault 库根目录', 'a/b/c/deep.md', 'p.png', { mode: 'vault', folder: 'assets' }, r('assets', 'assets/p.png', '../../../assets/p.png')],
  // 无页面:新建白板/仪表盘/Base、拖到文件树 都是 saveAttachment('', name, bytes, { mode: 'vault', folder })
  ['无页面 · 库根(实报复现那一发)', '', 'x.pdf', { mode: 'vault', folder: '' }, r('', 'x.pdf', 'x.pdf')],
  ['无页面 · 子目录', '', 'b.excalidraw.md', { mode: 'vault', folder: 'Boards/2026' }, r('Boards/2026', 'Boards/2026/b.excalidraw.md', 'Boards/2026/b.excalidraw.md')],
]
for (const [name, pagePath, base, opts, want] of CASES) check(name, () => assert.deepStrictEqual(mobile(pagePath, base, opts), want))

check('destDirRel 与(去重后的)文件名无关', () => {
  const opts = { mode: 'attachments', folder: '' }
  assert.equal(mobile('a/b.md', 'x.png', opts).destDirRel, mobile('a/b.md', 'x-1.png', opts).destDirRel)
})

check('与 desktop(node:path)逐格一致', () => {
  const m = { exports: {} }
  new Function('module', 'exports', 'require', bundle({ entryPoints: ['../desktop/electron/amadeus/fs/attachmentPaths.ts'], platform: 'node', format: 'cjs' }))(m, m.exports, require)
  // ponytail: 只比库内路径 —— 带 `..` 穿顶的输入 desktop 结果随 cwd 变、本身无意义,且 resolveInVault 会拒写。
  const pages = ['', 'ideas.md', 'Notes/ideas.md', 'a/b/c/deep.md', 'Notes\\win.md']
  const optsList = [['attachments', ''], ['same', ''], ['vault', ''], ['vault', 'assets'], ['vault', '/assets/'], ['vault', 'a/x'], ['vault', 'Notes']]
  for (const p of pages) for (const [mode, folder] of optsList) for (const base of ['p.png', 'with space.pdf']) {
    const opts = { mode, folder }
    assert.deepStrictEqual(mobile(p, base, opts), m.exports.attachmentPaths(p, base, opts), JSON.stringify([p, base, opts]))
  }
})

if (fails.length) { console.error(`❌ test:attachpaths —— ${fails.length} 项失败`); process.exit(1) }
console.log('✅ test:attachpaths —— 无 process 沙箱里 attachmentPaths 全部落位正确,且与 desktop 逐格一致')
