#!/usr/bin/env node
/**
 * 这次改动能不能走热更新(插件接口层热更新方案 A,2026-11-05;方案页在仓根 docs/ToBeImproved/插件接口层热更新方案_2026-11-04/)。
 * 只提示、不拦:PR 上把结论写进检查摘要,退出码恒为 0(--selftest 除外)。
 *
 *   node scripts/hot-update-scope.mjs --base <ref> [--head <ref>]                        一个改动(PR):分类 + 结论
 *   node scripts/hot-update-scope.mjs --history [--since 2026-11-05] [--ref origin/main]   main 上逐个提交统计(一个月后量比例用)
 *   node scripts/hot-update-scope.mjs --verify                                            接口层清单里的文件有没有被宿主别的文件在运行时引用
 *   node scripts/hot-update-scope.mjs --selftest
 *
 * 四档结论:
 *   none       只动了文档 / 测试 / CI,或插件接口类型(types.ts 没有运行时导出)→ 不用发版
 *   tangu      只动了引擎和 Tangu 界面(规则同热更新门禁:engine-release-gate.mjs 的 packageScope),没碰建表 / 迁移、
 *              没改引擎依赖 → 现在就能走热更新
 *   layer      另外还动了插件接口层(plugin-ctx-boundary.json)→ 接口层进包以后才能走热更新
 *   installer  动了别的宿主文件,或建表 / 引擎依赖 → 只能随安装包
 * 分类用的是这份检出里的两份清单(tangu-boundary.json、plugin-ctx-boundary.json);--history 回放旧提交也按今天的清单算。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { SCHEMA_SOURCES, packageScope } from '../../tangu-agent/scripts/engine-release-gate.mjs'

const boundary = createRequire(import.meta.url)('./tangu-boundary.check.cjs')
const GENESIS = boundary.GENESIS
const CTX_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-ctx-boundary.json')
const SCHEMA = SCHEMA_SOURCES.map((f) => `tangu-agent/${f}`)
// 开发工具(检查脚本、台架、harness 页、类型声明)不进安装包也不进热更新包;desktop/scripts 里只有这两份影响界面包。
// 发布门禁(packageScope)对热更新分支更严,连它们也不许碰 —— 这里答的是「这项改动要不要等安装包才能到用户手里」。
const TOOLING = /^desktop\/scripts\/(?!build-tangu-ui\.mjs$|tangu-boundary\.json$)/

export const VERDICTS = {
  none: '不用发版(只有文档 / 测试 / CI / 开发工具 / 插件接口类型)',
  tangu: '能走热更新(只动了引擎和 Tangu 界面)',
  layer: '接口层进包以后能走热更新(动了插件接口层,没动别的宿主文件)',
  installer: '只能随安装包',
}

/** 改动的文件分组 + 结论。纯函数:selftest 直接喂。 */
export function classify(paths, { tanguCfg, ctxCfg, depsChanged = false, desktopDepsChanged = false }) {
  // desktop/package.json 只有 dependencies 变了才算宿主改动(脚本、devDependencies、版本号到不了用户手里)
  if (!desktopDepsChanged) paths = paths.filter((f) => f !== 'desktop/package.json')
  const sets = Object.fromEntries(['layer', 'needsSplit', 'writesUserData', 'types'].map((k) => [k, new Set(ctxCfg[k] || [])]))
  const tooling = paths.filter((f) => TOOLING.test(f) || boundary.EXEMPT.test(f))
  const { host, ui } = packageScope(paths.filter((f) => !tooling.includes(f)), tanguCfg)
  const hostSet = new Set(host), uiSet = new Set(ui)
  const g = { engine: [], ui, layer: [], needsSplit: [], writesUserData: [], types: [], host: [], schema: [], notShipped: [] }
  for (const f of paths) {
    if (SCHEMA.includes(f)) g.schema.push(f)
    if (uiSet.has(f)) continue
    if (tooling.includes(f)) { g.notShipped.push(f); continue }
    if (!hostSet.has(f)) { (f.startsWith('tangu-agent/') ? g.engine : g.notShipped).push(f); continue }
    const k = ['types', 'layer', 'needsSplit', 'writesUserData'].find((key) => sets[key].has(f))
    ;(k ? g[k] : g.host).push(f)
  }
  const notes = []
  if (g.schema.length) notes.push(`改了建表 / 迁移(${g.schema.join(', ')}):热更新门禁不收`)
  if (depsChanged) notes.push('改了引擎的 dependencies:热更新门禁不收')
  if (g.needsSplit.length) notes.push(`动了还没拆开的 ${g.needsSplit.map((f) => path.basename(f)).join(' / ')}:接口层进包前要先拆`)
  if (g.writesUserData.length) notes.push(`动了写用户数据的 ${g.writesUserData.map((f) => path.basename(f)).join(' / ')}:进包前写盘那几步要留宿主或按写盘协议复核`)
  const verdict = g.host.length || g.schema.length || depsChanged ? 'installer'
    : g.layer.length || g.needsSplit.length || g.writesUserData.length ? 'layer'
    : g.engine.length || g.ui.length ? 'tangu'
    : 'none'
  return { verdict, groups: g, notes }
}

/** 清单自洽:接口层文件不能同时是 Tangu 界面文件,各组之间不重复。 */
export function configProblems(tanguCfg, ctxCfg) {
  const problems = [], seen = new Map()
  const isTangu = (f) => tanguCfg.tangu.dirs.some((d) => f.startsWith(d)) || tanguCfg.tangu.files.includes(f)
  for (const k of ['layer', 'needsSplit', 'writesUserData', 'types']) {
    for (const f of ctxCfg[k] || []) {
      if (isTangu(f)) problems.push(`${f} 在 plugin-ctx-boundary.json 的 ${k} 里,但它是 Tangu 界面文件(tangu-boundary.json)`)
      if (seen.has(f)) problems.push(`${f} 同时在 ${seen.get(f)} 和 ${k} 里`)
      seen.set(f, k)
    }
  }
  return problems
}

/** 宿主别的文件在运行时引用接口层文件的地方(只引类型不算;接口层自己、待拆的、写盘的、类型文件之间互引不算)。 */
export function reverseImports(files, ctxCfg) {
  const layer = new Set(ctxCfg.layer || [])
  const inside = new Set(['layer', 'needsSplit', 'writesUserData', 'types'].flatMap((k) => ctxCfg[k] || []))
  const out = []
  for (const [f, src] of files) {
    if (inside.has(f) || boundary.EXEMPT.test(f) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(f)) continue
    for (const m of boundary.stripComments(src).matchAll(boundary.IMPORT_RE)) {
      const spec = m[1] || m[3] || m[4] || m[5] || m[6]
      const to = boundary.resolveIn(files, f, spec)
      if (to && layer.has(to) && !boundary.typeOnly(boundary.lastStmt(m[0]))) out.push({ from: f, to })
    }
  }
  return out
}

const git = (...a) => execFileSync('git', a, { cwd: GENESIS, encoding: 'utf8', maxBuffer: 64 << 20 }).trim()
const lines = (s) => s.split('\n').filter(Boolean)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const depsAt = (rev, pkg = 'tangu-agent') => { try { return JSON.stringify(JSON.parse(git('show', `${rev}:${pkg}/package.json`)).dependencies ?? {}) } catch { return null } }
const configs = () => ({ tanguCfg: boundary.readConfig(), ctxCfg: readJson(CTX_FILE) })

const withCfg = ({ paths, depsChanged, desktopDepsChanged }, cfg) => [paths, { ...cfg, depsChanged, desktopDepsChanged }]

function changeBetween(from, to) {
  const paths = lines(git('diff', '--name-only', '--no-renames', from, to))
  const changed = (pkg) => { const a = depsAt(from, pkg), b = depsAt(to, pkg); return a !== null && b !== null && a !== b }
  return { paths, depsChanged: changed('tangu-agent'), desktopDepsChanged: paths.includes('desktop/package.json') && changed('desktop') }
}

function reportOne(base, head) {
  const cfg = configs()
  for (const p of configProblems(cfg.tanguCfg, cfg.ctxCfg)) console.log(`::warning title=热更新范围清单::${p}`)
  const mergeBase = git('merge-base', base, head)
  const r = classify(...withCfg(changeBetween(mergeBase, head), cfg))
  const label = { engine: '引擎', ui: 'Tangu 界面', layer: '插件接口层', needsSplit: '接口层(待拆)', writesUserData: '接口层(写用户数据)', types: '插件接口类型', host: '别的宿主文件', notShipped: '文档 / 测试 / CI / 开发工具' }
  const rows = Object.entries(label).filter(([k]) => r.groups[k].length)
    .map(([k, name]) => `| ${name} | ${r.groups[k].length} | ${r.groups[k].slice(0, 6).map((f) => `\`${f}\``).join('<br>')}${r.groups[k].length > 6 ? `<br>…还有 ${r.groups[k].length - 6} 个` : ''} |`)
  const md = [`### 热更新范围:${VERDICTS[r.verdict]}`, '', ...r.notes.map((n) => `- ${n}`), '', '| 类别 | 文件数 | 文件 |', '|---|---|---|', ...rows, '',
    '只提示、不拦。规则:能走热更新 = 只动了引擎和 Tangu 界面(同热更新门禁);接口层进包是待定方案,先量一个月。'].join('\n')
  console.log(md)
  console.log(`::notice title=热更新范围::${VERDICTS[r.verdict]}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
}

function history(ref, since) {
  const cfg = configs()
  const commits = lines(git('rev-list', '--first-parent', `--since=${since}`, ref))
  const all = { none: [], tangu: [], layer: [], installer: [] }
  const plugin = { none: [], tangu: [], layer: [], installer: [] }
  const pluginFiles = new Set(['layer', 'needsSplit', 'writesUserData', 'types'].flatMap((k) => cfg.ctxCfg[k] || []))
  for (const c of commits) {
    const parents = git('rev-list', '--parents', '-n', '1', c).split(' ')
    if (parents.length < 2) continue
    const change = changeBetween(parents[1], c)
    const { paths } = change
    const r = classify(...withCfg(change, cfg))
    const line = `${c.slice(0, 9)} ${git('log', '-1', '--format=%s', c).slice(0, 72)}`
    all[r.verdict].push(line)
    if (paths.some((f) => pluginFiles.has(f))) plugin[r.verdict].push(line)
  }
  const pct = (n, d) => (d ? `${Math.round((n * 100) / d)}%` : '-')
  const table = (t) => { const n = Object.values(t).reduce((s, v) => s + v.length, 0); return Object.keys(VERDICTS).map((k) => `  ${VERDICTS[k]}: ${t[k].length} / ${n}(${pct(t[k].length, n)})`).join('\n') }
  console.log(`${ref} 自 ${since} 起 ${commits.length} 个提交(按 first-parent,一个 PR 一个)\n\n全部:\n${table(all)}\n\n其中动了插件接口层或接口类型的:\n${table(plugin)}`)
  for (const k of ['tangu', 'layer']) if (plugin[k].length) console.log(`\n接口改动里「${VERDICTS[k]}」的:\n  ${plugin[k].join('\n  ')}`)
}

function verify() {
  const cfg = configs()
  const problems = configProblems(cfg.tanguCfg, cfg.ctxCfg)
  const files = boundary.readRepo()
  for (const k of ['layer', 'needsSplit', 'writesUserData', 'types']) for (const f of cfg.ctxCfg[k] || []) if (!files.has(f)) problems.push(`${f}(${k})不存在了`)
  for (const { from, to } of reverseImports(files, cfg.ctxCfg)) problems.push(`宿主在运行时引用了接口层文件:${from} → ${to}(进包后就是两份;要么改走 ctx / 接缝,要么把它挪进 needsSplit)`)
  for (const p of problems) console.log(`::warning title=插件接口层清单::${p}`)
  console.log(problems.length ? `\n插件接口层清单:${problems.length} 处要看(只提示)` : '插件接口层清单 OK —— 接口层文件没有被宿主别的文件在运行时引用')
}

function selftest() {
  const tanguCfg = { tangu: { dirs: ['desktop/frontend/src/tangu/'], files: [] }, contracts: { dirs: ['tangu-agent/src/contracts/'] } }
  const P = 'desktop/frontend/src/amadeus/plugins/'
  const ctxCfg = { layer: [`${P}chatBoxSurface.tsx`], needsSplit: [`${P}pluginStore.ts`], writesUserData: [`${P}pluginData.ts`], types: [`${P}types.ts`] }
  const v = (paths, o = {}) => classify(paths, { tanguCfg, ctxCfg, ...o })
  const cases = [
    ['docs and tests only', () => assert.equal(v(['docs/a.md', `${P}chatBoxSurface.test.ts`, '.github/workflows/x.yml']).verdict, 'none')],
    ['plugin types only', () => assert.equal(v([`${P}types.ts`, 'docs/customization/plugin-development.md']).verdict, 'none')],
    ['engine + Tangu UI', () => assert.equal(v(['tangu-agent/src/agent.ts', 'desktop/frontend/src/tangu/Chat.tsx']).verdict, 'tangu')],
    ['interface layer', () => assert.equal(v([`${P}chatBoxSurface.tsx`, `${P}types.ts`]).verdict, 'layer')],
    ['pluginStore and write paths count as layer, with notes', () => {
      const r = v([`${P}pluginStore.ts`, `${P}pluginData.ts`])
      assert.equal(r.verdict, 'layer')
      assert.match(r.notes.join(), /先拆.*写盘/s)
    }],
    ['any other host file → installer', () => assert.equal(v([`${P}chatBoxSurface.tsx`, 'desktop/frontend/src/amadeus/store/dbAggregateStore.ts']).verdict, 'installer')],
    ['contracts are host', () => assert.equal(v(['tangu-agent/src/contracts/events.ts']).verdict, 'installer')],
    ['schema or engine deps → installer', () => {
      assert.equal(v(['tangu-agent/src/db/migrate.ts']).verdict, 'installer')
      assert.equal(v(['tangu-agent/src/agent.ts'], { depsChanged: true }).verdict, 'installer')
    }],
    ['dev tooling, harness pages and type declarations do not count; the UI build script does', () => {
      assert.equal(v(['desktop/scripts/plugin-compat.check.cjs', 'desktop/frontend/src/views/harness.tsx', 'desktop/shared/x.d.ts', 'tangu-agent/src/a.ts']).verdict, 'tangu')
      assert.equal(v(['desktop/scripts/build-tangu-ui.mjs']).verdict, 'installer')
    }],
    ['desktop/package.json counts only when its dependencies change', () => {
      assert.equal(v(['desktop/package.json', 'tangu-agent/src/a.ts']).verdict, 'tangu')
      assert.equal(v(['desktop/package.json', 'tangu-agent/src/a.ts'], { desktopDepsChanged: true }).verdict, 'installer')
    }],
    ['?raw markdown in the host counts', () => assert.equal(v(['desktop/CHANGELOG.md']).verdict, 'installer')],
    ['config: a layer file may not be a Tangu file, nor listed twice', () => {
      assert.match(configProblems(tanguCfg, { layer: ['desktop/frontend/src/tangu/x.ts'] }).join(), /Tangu 界面文件/)
      assert.match(configProblems(tanguCfg, { layer: [`${P}a.ts`], types: [`${P}a.ts`] }).join(), /同时在 layer 和 types/)
    }],
    ['reverse imports: runtime import from the host is reported, type-only and layer-internal are not', () => {
      const files = new Map([
        [`${P}chatBoxSurface.tsx`, 'export const mount = 1\n'],
        [`${P}pluginStore.ts`, "import { mount } from './chatBoxSurface'\n"],
        ['desktop/frontend/src/views/A.tsx', "import { mount } from '@/amadeus/plugins/chatBoxSurface'\n"],
        ['desktop/frontend/src/views/B.tsx', "import type { X } from '@/amadeus/plugins/chatBoxSurface'\n"],
      ])
      assert.deepEqual(reverseImports(files, ctxCfg), [{ from: 'desktop/frontend/src/views/A.tsx', to: `${P}chatBoxSurface.tsx` }])
    }],
  ]
  let failed = 0
  for (const [name, fn] of cases) { try { fn(); console.log(`PASS  ${name}`) } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`) } }
  console.log(`hot-update-scope selftest: ${cases.length - failed}/${cases.length} PASS`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
  if (process.argv.includes('--selftest')) selftest()
  else try {
    if (process.argv.includes('--verify')) verify()
    else if (process.argv.includes('--history')) history(arg('--ref') || 'origin/main', arg('--since') || '2026-11-05')
    else reportOne(arg('--base') || 'origin/main', arg('--head') || 'HEAD')
  } catch (e) {
    // 只提示:自己出错也不挡 PR
    console.log(`::warning title=热更新范围::没算出来:${(e && e.message) || e}`)
  }
}
