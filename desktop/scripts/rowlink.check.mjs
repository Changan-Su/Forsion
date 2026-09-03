#!/usr/bin/env node
// 关联悬空扫描 check:rowlink —— 扫一个 vault 目录下全部 .db(经典 JSON 表),**报告**跨文件悬空,不修复
// (删一条库存不该静默改动出库/订单两张表;同文件内的自引用清理在渲染层 rowLink.dropSelfRefs)。五类:
//   refdb-missing   rowlink / 反向 lookup 的 refDb 指向不存在的 .db
//   backcol-bad     反向 lookup 的 lookupBackCol 不是目标表的 rowlink 列、或它不指回本表
//   row-missing     rowlink 单元格含目标表里不存在的行 id(已失联)
//   lookup-half     lookup 半配置:正向 lookupRel 空或指向不存在的列 / 反向缺 lookupBackCol / lookupCol 在目标表里不存在
//                   (投影列 lookupKind='links' 不看 lookupCol:它的值是指回本行的行 id 数组,与 shared/db/backlink.ts pairIssues 同口径)
//   proj-bad        投影列(lookupKind='links')半残:不是反向模式(缺 refDb / lookupBackCol);指回列不是 rowlink / 不指回本表仍报 backcol-bad
//   cfg-bad         rowlink 的 titleCol 指向不存在或计算列(formula/lookup);refFilter 的 colId 在目标表里不存在;
//                   正向 lookup 的 lookupRel 指向的列还在但已不是 rowlink(休眠,改回关联表即恢复 —— 提示,不当悬空)
//   corrupt         文件读不成表(JSON 坏 / 缺 columns、rows 数组)—— 也算一条,别静默跳过
// 用法:node scripts/rowlink.check.mjs <vaultDir> [--json]    有悬空 exit 1
//       node scripts/rowlink.check.mjs                        无参 = 自测(--selftest):临时目录造五类夹具 + 负对照,
//                                                             每类恰好命中一条、干净库零条;npm run check:rowlink 跑的就是它
// 纯 node,不 import TS/zod:结构守卫手写(与 schema.ts 的 dbFileSchema 是「宽松版」,只看本脚本用到的字段)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '')
const isComputed = (t) => t === 'formula' || t === 'lookup'

/** 递归收 .db(跳过点目录与 node_modules),键 = 相对 vault 根的 `/` 分隔路径。 */
function collectDbs(root) {
  const out = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (/\.db$/i.test(ent.name)) out.push(norm(path.relative(root, full)))
    }
  }
  walk(root)
  return out.sort()
}

/** 宽松读:JSON + columns/rows 数组守卫;读不成返回 null(调用方记一条 corrupt)。 */
function readDb(root, rel) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
    if (!raw || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null
    return raw
  } catch {
    return null
  }
}

export function scanVault(root) {
  const issues = []
  const add = (kind, file, col, detail) => issues.push({ kind, file, col, detail })
  const rels = collectDbs(root)
  const dbs = new Map()
  for (const rel of rels) {
    const d = readDb(root, rel)
    if (d) dbs.set(rel, d)
    else add('corrupt', rel, '', '不是有效的 Database 文件')
  }
  for (const [file, d] of dbs) {
    const colById = new Map(d.columns.map((c) => [c.id, c]))
    for (const c of d.columns) {
      if (c.type === 'rowlink') {
        if (!c.refDb) continue // 未设目标表:渲染层有「未设目标表」提示,不算悬空
        const target = dbs.get(norm(c.refDb))
        if (!target) { add('refdb-missing', file, c.id, `refDb=${c.refDb}`); continue }
        const tcols = new Map(target.columns.map((x) => [x.id, x]))
        if (c.titleCol !== undefined) {
          const tc = tcols.get(c.titleCol)
          if (!tc) add('cfg-bad', file, c.id, `titleCol=${c.titleCol} 在目标表里不存在`)
          else if (isComputed(tc.type)) add('cfg-bad', file, c.id, `titleCol=${c.titleCol} 是计算列(磁盘无值)`)
        }
        for (const f of c.refFilter ?? []) {
          if (!tcols.has(f.colId)) add('cfg-bad', file, c.id, `refFilter 列 ${f.colId} 在目标表里不存在`)
        }
        if (d.source) continue // 笔记视图:行是笔记,rows 恒空
        const ids = new Set(target.rows.map((r) => r.id))
        for (const r of d.rows) {
          const v = r.cells?.[c.id]
          const refs = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []
          for (const id of refs) if (!ids.has(id)) add('row-missing', file, c.id, `行 ${r.id} 引用了目标表不存在的 ${id}`)
        }
      } else if (c.type === 'lookup') {
        const back = !!c.refDb && !!c.lookupBackCol
        const proj = c.lookupKind === 'links'
        if (proj && !back) { add('proj-bad', file, c.id, `投影列缺 ${!c.refDb ? 'refDb' : 'lookupBackCol'}(不是反向模式)`); continue }
        if (back) {
          const target = dbs.get(norm(c.refDb))
          if (!target) { add('refdb-missing', file, c.id, `refDb=${c.refDb}`); continue }
          const bc = target.columns.find((x) => x.id === c.lookupBackCol)
          if (!bc || bc.type !== 'rowlink' || !bc.refDb || norm(bc.refDb) !== file) {
            add('backcol-bad', file, c.id, `lookupBackCol=${c.lookupBackCol} ${!bc ? '不存在' : bc.type !== 'rowlink' ? '不是关联表列' : `指向 ${bc.refDb ?? '(空)'} 而非本表`}`)
          }
          // 投影列没有 lookupCol(值 = 指回本行的行 id 数组),不算半配置
          if (!proj && (!c.lookupCol || !target.columns.some((x) => x.id === c.lookupCol))) add('lookup-half', file, c.id, `lookupCol=${c.lookupCol ?? '(空)'} 在目标表里不存在`)
        } else {
          const rel = c.lookupRel ? colById.get(c.lookupRel) : undefined
          if (!rel) { add('lookup-half', file, c.id, `lookupRel=${c.lookupRel ?? '(空)'} 不是本表的列(待重新配置)`); continue }
          // 关联列还在、只是被改成了别的类型:lookup 休眠(渲染层刻意不清配置,改回关联表即恢复)—— 报 cfg-bad 提示,不是悬空
          if (rel.type !== 'rowlink') { add('cfg-bad', file, c.id, `lookupRel=${c.lookupRel} 现在是 ${rel.type} 列,lookup 休眠中(改回关联表即恢复)`); continue }
          if (c.refDb) add('lookup-half', file, c.id, '同时带 refDb 与 lookupRel,两边各解一半')
          const target = rel.refDb ? dbs.get(norm(rel.refDb)) : undefined
          if (!c.lookupCol) add('lookup-half', file, c.id, 'lookupCol 未设')
          else if (target && !target.columns.some((x) => x.id === c.lookupCol)) add('lookup-half', file, c.id, `lookupCol=${c.lookupCol} 在目标表里不存在`)
        }
      }
    }
  }
  return { files: rels.length, issues }
}

// ── 自测:五类夹具各恰好一条 + 干净库零条 + 负对照(合法 id / `./` 路径口径 / 未设目标表不误报) ──
function selftest() {
  const col = (id, type, extra = {}) => ({ id, name: id, type, ...extra })
  const mk = (columns, rows = [], extra = {}) => ({ version: 1, name: 'x', columns, rows, ...extra })
  const write = (tree) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rowlink-check-'))
    for (const [rel, db] of Object.entries(tree)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), typeof db === 'string' ? db : JSON.stringify(db, null, 2))
    }
    return root
  }
  const clean = () => ({
    'a.db': mk(
      [col('t', 'text'), col('rel', 'rowlink', { refDb: 'sub/b.db', titleCol: 'no', refFilter: [{ colId: 'kind', op: 'eq', value: 'x' }] }), col('lk', 'lookup', { lookupRel: 'rel', lookupCol: 'kind' }), col('self', 'rowlink', { refDb: './a.db' })],
      [{ id: 'a1', cells: { rel: 'b1', self: 'a2' } }, { id: 'a2', cells: { rel: ['b1', 'b2'] } }],
    ),
    'sub/b.db': mk(
      // proj = 可编辑投影列(lookupKind='links',**没有** lookupCol):干净库里它必须零条 —— 少了 proj 分支它会被 lookup-half 误报
      [col('no', 'autonumber', { prefix: 'B-' }), col('kind', 'select'), col('back', 'lookup', { refDb: 'a.db', lookupBackCol: 'rel', lookupCol: 't', lookupAgg: 'join' }), col('sum', 'formula', { formula: '1' }), col('proj', 'lookup', { refDb: 'a.db', lookupBackCol: 'rel', lookupKind: 'links' })],
      [{ id: 'b1', cells: { no: 1 } }, { id: 'b2', cells: { no: 2 } }],
    ),
    'notes.db': mk([col('__page_name', 'page'), col('rel', 'rowlink', { refDb: 'a.db' })], [], { source: { folder: 'n' } }),
    'unset.db': mk([col('t', 'text'), col('rel', 'rowlink')]), // 未设目标表:不算悬空
  })
  const cases = [
    ['干净库 → 0 条(负对照:合法 id / `./` 与子目录路径口径 / 笔记视图 / 未设目标表都不误报)', clean(), []],
    ['refdb-missing', (() => { const t = clean(); t['a.db'].columns.push(col('gone', 'rowlink', { refDb: 'gone.db' })); return t })(), ['refdb-missing']],
    ['refdb-missing(反向)', (() => { const t = clean(); t['sub/b.db'].columns[2].refDb = 'gone.db'; return t })(), ['refdb-missing']],
    ['backcol-bad(指回列指向别的表)', (() => { const t = clean(); t['sub/b.db'].columns[2].lookupBackCol = 'self'; return t })(), ['backcol-bad']],
    ['backcol-bad(指回列不是 rowlink)', (() => { const t = clean(); t['sub/b.db'].columns[2].lookupBackCol = 't'; return t })(), ['backcol-bad']],
    ['row-missing', (() => { const t = clean(); t['a.db'].rows[1].cells.rel = ['b1', 'b9']; return t })(), ['row-missing']],
    ['lookup-half(正向 lookupRel 被清 = 待重新配置)', (() => { const t = clean(); delete t['a.db'].columns[2].lookupRel; return t })(), ['lookup-half']],
    ['lookup-half(lookupCol 在目标表不存在)', (() => { const t = clean(); t['a.db'].columns[2].lookupCol = 'nope'; return t })(), ['lookup-half']],
    // 沿 self 列(没人反向指回它)改类型:只该报一条 cfg-bad;改 rel 会连带 b.db 的反向 backcol-bad,那是另一类真悬空
    ['cfg-bad(lookupRel 指向的列被改成 text = 休眠,不是 lookup-half)', (() => { const t = clean(); t['a.db'].columns[2].lookupRel = 'self'; t['a.db'].columns[2].lookupCol = 't'; t['a.db'].columns[3].type = 'text'; return t })(), ['cfg-bad']],
    ['cfg-bad(titleCol 是计算列)', (() => { const t = clean(); t['a.db'].columns[1].titleCol = 'sum'; return t })(), ['cfg-bad']],
    ['cfg-bad(refFilter 列不存在)', (() => { const t = clean(); t['a.db'].columns[1].refFilter = [{ colId: 'zzz', op: 'eq', value: 1 }]; return t })(), ['cfg-bad']],
    ['corrupt', (() => { const t = clean(); t['bad.db'] = '{not json'; return t })(), ['corrupt']],
    // 投影列(pairIssues 同口径):缺指回列 = proj-bad;指回列不是 rowlink / 不指回本表 = backcol-bad(与普通反向 lookup 同类)
    ['proj-bad(投影列缺 lookupBackCol)', (() => { const t = clean(); delete t['sub/b.db'].columns[4].lookupBackCol; return t })(), ['proj-bad']],
    ['backcol-bad(投影列指回列不是 rowlink)', (() => { const t = clean(); t['sub/b.db'].columns[4].lookupBackCol = 't'; return t })(), ['backcol-bad']],
    ['backcol-bad(投影列指回列指向别的表)', (() => { const t = clean(); t['sub/b.db'].columns[4].lookupBackCol = 'self'; return t })(), ['backcol-bad']],
  ]
  let failed = 0
  for (const [name, tree, want] of cases) {
    const root = write(tree)
    const { issues } = scanVault(root)
    fs.rmSync(root, { recursive: true, force: true })
    const got = issues.map((i) => i.kind).sort()
    const ok = JSON.stringify(got) === JSON.stringify([...want].sort())
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  | got=${JSON.stringify(got)} want=${JSON.stringify(want)}${ok ? '' : ' ' + JSON.stringify(issues)}`)
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const dir = args.find((a) => !a.startsWith('--'))
  if (!dir || args.includes('--selftest')) selftest()
  else {
    const root = path.resolve(dir)
    if (!fs.existsSync(root)) { console.error(`目录不存在:${root}`); process.exit(2) }
    const r = scanVault(root)
    if (json) console.log(JSON.stringify(r, null, 2))
    else {
      for (const i of r.issues) console.log(`${i.kind.padEnd(14)} ${i.file}  列 ${i.col || '-'}  ${i.detail}`)
      console.log(`\n扫描 ${r.files} 个 .db,${r.issues.length} 条悬空`)
    }
    process.exit(r.issues.length ? 1 : 0)
  }
}
