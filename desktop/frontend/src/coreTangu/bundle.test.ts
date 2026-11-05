/**
 * 界面热更新 4a 的仪器:build-tangu-ui.mjs 的核对规则(负对照)+ 包的求值约定(小样真构建、真求值)。
 * 真仓那次构建由 `node scripts/build-tangu-ui.mjs` 跑(CI:.github/workflows/tangu-ui.yml)。
 */
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
// @ts-expect-error 构建脚本是 .mjs,没有类型声明
import { analyzeBuild, buildOptions, classifier, renderTable, tanguUiPlugin } from '../../../scripts/build-tangu-ui.mjs'
import { createHostRequire } from './hostRequire'

const ROOT = '/repo'
const cfg = { tangu: { dirs: ['desktop/frontend/src/tangu/'], files: ['desktop/frontend/src/A.tsx'] }, contracts: { dirs: ['tangu-agent/src/contracts/'] } }
const classify = classifier(cfg)
const meta = (inputs: string[], externals: string[]) => ({
  inputs: Object.fromEntries(inputs.map((i) => [i, {}])),
  outputs: { 'main.js': { imports: externals.map((p) => ({ path: p, external: true })) } },
})
const HOST = 'host:desktop/frontend/src/i18n.tsx'
const EXTERNALS = [HOST, 'react', 'react/jsx-runtime']
const clean = {
  metafile: meta(['tangu-ui:entry', 'desktop/frontend/src/A.tsx', 'desktop/frontend/src/tangu/b.ts', 'tangu-agent/src/contracts/c.ts', 'desktop/node_modules/lucide-react/dist/x.js'], [HOST, 'react', 'react/jsx-runtime']),
  code: 'Promise.resolve().then(() => __require("host:desktop/frontend/src/i18n.tsx"))',
  cwd: ROOT, root: ROOT, classify,
  baseline: ['desktop/frontend/src/i18n.tsx'],
  tableSource: renderTable(EXTERNALS) as string,
  readName: (dir: string): string | null => (dir.endsWith('/react-copy') ? 'react' : null), // npm 别名:react-copy: npm:react
}
const run = (patch: Partial<typeof clean>) => analyzeBuild({ ...clean, ...patch }).errors.join('\n')

describe('analyzeBuild', () => {
  it('a clean build passes', () => expect(run({})).toBe(''))
  it('a CRLF checkout of the table (Windows, core.autocrlf) still matches', () => expect(run({ tableSource: (renderTable(EXTERNALS) as string).replace(/\n/g, '\r\n') })).toBe(''))
  it('a hand-edited table is red', () => expect(run({ tableSource: (renderTable(EXTERNALS) as string).replace('m0 from', 'm0  from') })).toMatch(/edited by hand/))
  it('a host file bundled into the package is red (P3: two copies of a store)', () => {
    expect(run({ metafile: meta([...Object.keys(clean.metafile.inputs), 'desktop/frontend/src/stores/appStore.ts'], EXTERNALS) })).toMatch(/host file bundled.*appStore/)
  })
  it('a shared package bundled into the package is red (two Reacts)', () => {
    expect(run({ metafile: meta(['../elsewhere/node_modules/react/index.js'], EXTERNALS) })).toMatch(/shared package react was bundled/)
    expect(run({ metafile: meta(['desktop/node_modules/react-copy/index.js'], EXTERNALS) })).toMatch(/shared package react was bundled/) // 别名装进来的也认
  })
  it('a host module outside the boundary baseline is red (the table may only shrink)', () => {
    const ext = [...EXTERNALS, 'host:desktop/frontend/src/new.ts']
    expect(run({ metafile: meta([], ext), tableSource: renderTable(ext) })).toMatch(/not in the boundary baseline/)
  })
  it('a third-party external that is not shared is red', () => {
    const ext = [...EXTERNALS, 'lodash']
    expect(run({ metafile: meta([], ext), tableSource: renderTable(ext) })).toMatch(/lodash is external but not a shared package/)
  })
  it('a stale or hand-edited table is red', () => {
    expect(run({ tableSource: renderTable([HOST, 'react']) })).toMatch(/missing: react\/jsx-runtime/)
    expect(run({ tableSource: renderTable([...EXTERNALS, 'zustand']) })).toMatch(/stale: zustand/)
    // 键还在、指向的模块被换了:运行时拿到的是别的命名空间
    expect(run({ tableSource: renderTable(EXTERNALS).replace("'@/i18n'", "'@/agentName'") })).toMatch(/edited by hand/)
  })
  it('a default import of a host module from a .mjs/.mts file is red (esbuild hands it the whole namespace)', () => {
    expect(run({ code: 'var import_i18n=__toESM(__require("host:desktop/frontend/src/i18n.tsx"),1);' })).toMatch(/\.mjs\/\.mts file default-imports host:/)
    expect(run({ code: 'var import_i18n=__toESM(__require("host:desktop/frontend/src/i18n.tsx"));' })).toBe('')
  })
  it('a dynamic import left for the host is red', () => {
    expect(run({ code: 'import("host:desktop/frontend/src/i18n.tsx")' })).toMatch(/survived the build/)
  })
  it('renderTable writes host modules through their usual alias, never @tangu/ui', () => {
    const src = renderTable(['host:desktop/frontend/src/i18n.tsx', 'host:desktop/frontend/src/styles/x.css', 'host:lcl/engine/index.ts', 'host:desktop/shared/chatBox.ts', 'react'])
    expect(src).toContain("import * as m0 from '@/i18n'")
    expect(src).toContain("import '@/styles/x.css'")
    expect(src).toContain("import * as m2 from '@lcl/engine/index'")
    expect(src).toContain("import * as m3 from '../../../shared/chatBox'")
    expect(src).toContain("'react': m4,")
    expect(src).not.toContain('@tangu/ui')
  })
})

describe('bundle contract (fixture: real esbuild build, evaluated like the 4b loader will)', () => {
  it('default / named / live / dynamic host imports and CSS (incl. lazily loaded CSS) all come through', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tangu-ui-'))) // macOS 的 /var 是软链
    const w = (rel: string, src: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), src) }
    w('host/h.mjs', "export default 'D'\nexport let n = 0\nexport const inc = () => { n++ }\n")
    w('host/lazy.mjs', "export default 'L'\n")
    w('tangu/look.css', '.tangu-look { color: red }')
    w('tangu/later.css', '.tangu-later { color: blue }')
    w('tangu/later.ts', "import './later.css'\nexport const later = 1\n")
    w('tangu/entry.tsx', [
      "import D, { n } from '../host/h.mjs'",
      "import './look.css'",
      'export const readDefault = () => D',
      'export const readN = () => n',
      "export const lazy = () => import('../host/lazy.mjs').then((m) => m.default)",
      "export const lazyTangu = () => import('./later').then((m) => m.later)",
      'export const el = () => <b>x</b>',
    ].join('\n'))
    const r = await build(buildOptions({
      plugin: tanguUiPlugin({ root, classify: (rel: string) => (rel.startsWith('tangu/') ? 'tangu' : 'host'), entry: path.join(root, 'tangu/entry.tsx'), alias: [] }),
      outfile: path.join(root, 'out/main.js'),
    }))
    const code = r.outputFiles[0].text
    expect(analyzeBuild({ metafile: r.metafile, code, root, classify: (rel: string) => (rel.startsWith('tangu/') ? 'tangu' : 'host'), baseline: ['host/h.mjs', 'host/lazy.mjs'], tableSource: null }).errors).toEqual([])
    const h = await import(pathToFileURL(path.join(root, 'host/h.mjs')).href)
    const table = {
      'host:host/h.mjs': h,
      'host:host/lazy.mjs': await import(pathToFileURL(path.join(root, 'host/lazy.mjs')).href),
      'react/jsx-runtime': { jsx: (type: string, props: object) => ({ type, props }) },
    }
    const { exports, css, onCss } = new Function('require', code)(createHostRequire(table))
    const late: string[] = []
    onCss((sheet: string) => late.push(sheet))
    expect(exports.readDefault()).toBe('D') // 没有 __esModule 包装时这里拿到的是整个命名空间
    h.inc()
    expect(exports.readN()).toBe(1) // 活绑定
    await expect(exports.lazy()).resolves.toBe('L') // 动态 import 到调用时才向宿主要
    expect(exports.el()).toEqual({ type: 'b', props: { children: 'x' } })
    expect(css).toContain('.tangu-look')
    expect(css).not.toContain('.tangu-later') // 动态 import 的模块还没加载
    await expect(exports.lazyTangu()).resolves.toBe(1)
    expect(late.join()).toContain('.tangu-later') // 加载时交给接收方,不会丢
    expect(code).toMatch(/^"use strict";/)
    expect(() => createHostRequire(table)('host:nope')).toThrow(/not in the shared module table/)
  })
})
