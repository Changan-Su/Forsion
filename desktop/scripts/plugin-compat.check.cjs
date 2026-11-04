#!/usr/bin/env node
// Which ctx members does a plugin use that its declared minAppVersion doesn't have?
//
//   node scripts/plugin-compat.check.cjs <plugin dir> [--min <version>] [--name <ident>]... [--strict]
//   node scripts/plugin-compat.check.cjs --self-test
//
// Reads `types.ts` at tag v<minAppVersion> and in this checkout, lists both as member paths (`databases.setBody`,
// `ui.chatBoxCapabilities`), then scans the plugin's `src/` (or `main.js`) for `ctx.…` / `ctx().…` chains.
// A path this checkout knows but the tag doesn't is reported: the plugin needs a fallback there, or a higher
// minAppVersion. Report-only unless `--strict` (exit 1 on findings).
// ponytail: regex scan, so bundles that rename `ctx` are missed — pass `--name c` for `const c = ctx()` aliases;
// option-level behaviour (`suggest` arrays) is invisible here, that is what the *Capabilities lists are for.
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const ts = require('typescript')

const TYPES = 'desktop/frontend/src/amadeus/plugins/types.ts'
const ROOT = path.resolve(__dirname, '../..')

/** Member paths of `interface PluginContext`, following inline type literals and same-file interfaces (depth 4). */
function memberPaths(source) {
  const sf = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true)
  const decls = new Map()
  sf.forEachChild((n) => { if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) decls.set(n.name.text, n) })
  const out = new Set()
  const membersOf = (node) => {
    if (!node) return []
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) return node.members
    if (ts.isTypeAliasDeclaration(node)) return membersOf(node.type)
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return membersOf(decls.get(node.typeName.text))
    if (ts.isParenthesizedTypeNode(node)) return membersOf(node.type)
    return []
  }
  const walk = (node, prefix, depth, seen) => {
    for (const m of membersOf(node)) {
      if (!m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) continue
      const p = prefix ? `${prefix}.${m.name.text}` : m.name.text
      out.add(p)
      const ref = m.type && ts.isTypeReferenceNode(m.type) && ts.isIdentifier(m.type.typeName) ? m.type.typeName.text : null
      if (depth < 4 && m.type && !(ref && seen.has(ref))) walk(m.type, p, depth + 1, ref ? new Set([...seen, ref]) : seen)
    }
  }
  walk(decls.get('PluginContext'), '', 0, new Set(['PluginContext']))
  return out
}

/** `ctx.a?.b.c(` / `ctx().a!.b!(` chains → [{ path: ['a','b','c'], line }]. */
function scanUsage(text, names = []) {
  const ids = ['ctx', ...names].map((n) => n.replace(/[$]/g, '\\$')).join('|')
  const re = new RegExp(`(?<![\\w$.])(?:${ids})(?:\\(\\))?((?:\\s*!?\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g')
  const hits = []
  for (const m of text.matchAll(re)) {
    const segs = m[1].replace(/[\s!?]/g, '').split('.').filter(Boolean)
    hits.push({ path: segs, line: text.slice(0, m.index).split('\n').length })
  }
  return hits
}

/** Longest prefix of `segs` that `known` has, as a dotted path (null if none). */
function knownPrefix(segs, known) {
  for (let i = segs.length; i > 0; i--) { const p = segs.slice(0, i).join('.'); if (known.has(p)) return p }
  return null
}

function findings(files, now, then, names) {
  const missing = new Map()
  for (const [file, text] of files) for (const { path: segs, line } of scanUsage(text, names)) {
    const p = knownPrefix(segs, now)
    if (!p || then.has(p)) continue
    if (!missing.has(p)) missing.set(p, [])
    missing.get(p).push(`${file}:${line}`)
  }
  return missing
}

function pluginFiles(dir) {
  const src = path.join(dir, 'src')
  const list = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f) } else if (/\.(m?[jt]sx?)$/.test(e.name) && !/\.test\./.test(e.name)) list.push(f)
  } }
  if (fs.existsSync(src)) walk(src)
  else if (fs.existsSync(path.join(dir, 'main.js'))) list.push(path.join(dir, 'main.js'))
  return list.map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')])
}

function selfTest() {
  const assert = require('assert')
  const types = `interface PluginAppApi { readFile(p: string): string; listTags?(): string[] }
    export interface PluginContext { app: PluginAppApi; ui?: { mountChatBox?(el: unknown): void; readonly chatBoxCapabilities?: readonly string[] }
      databases?: { setCell(): boolean; setBody?(): boolean } }`
  const now = memberPaths(types)
  for (const p of ['app.listTags', 'ui.chatBoxCapabilities', 'databases.setBody']) assert(now.has(p), p)
  const then = memberPaths(types.replace('setBody?(): boolean', '').replace('; listTags?(): string[]', ''))
  const code = "const ok = !!ctx().ui?.mountChatBox && !!ctx().databases?.setBody\nctx.app.listTags?.()\nc.databases.setBody(x)\nfoo.ctx.databases.setBody\nctx().databases!.setBody!(p)"
  const got = findings([['a.ts', code]], now, then, ['c'])
  assert.deepStrictEqual([...got.keys()].sort(), ['app.listTags', 'databases.setBody'])
  assert.deepStrictEqual(got.get('databases.setBody'), ['a.ts:1', 'a.ts:3', 'a.ts:5']) // `foo.ctx` is not the plugin ctx; `!` doesn't end a chain
  console.log('plugin-compat self-test ok')
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest()
  const names = [], args = []
  let min = null, strict = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') names.push(argv[++i])
    else if (argv[i] === '--min') min = argv[++i]
    else if (argv[i] === '--strict') strict = true
    else args.push(argv[i])
  }
  const dir = args[0] && path.resolve(args[0])
  if (!dir || !fs.existsSync(dir)) { console.error('usage: plugin-compat.check.cjs <plugin dir> [--min <version>] [--name <ident>]... [--strict]'); process.exit(2) }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  min = min ?? manifest.minAppVersion
  if (!min) { console.log(`${manifest.id}: no minAppVersion — every host counts, nothing to compare against.`); return }
  const tag = `v${min}`
  let then
  try { then = memberPaths(execFileSync('git', ['show', `${tag}:${TYPES}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
  catch { console.error(`${manifest.id}: no ${TYPES} at tag ${tag} (git fetch --tags?)`); process.exit(2) }
  const now = memberPaths(fs.readFileSync(path.join(ROOT, TYPES), 'utf8'))
  const files = pluginFiles(dir)
  const missing = findings(files, now, then, names)
  console.log(`${manifest.id} ${manifest.version ?? ''}: minAppVersion ${min}, ${files.length} file(s) scanned`)
  if (!missing.size) { console.log(`  ok — every ctx member it uses is in ${tag}`); return }
  console.log(`  ${missing.size} member(s) newer than ${tag}; each needs a fallback there, or raise minAppVersion:`)
  for (const [p, at] of [...missing].sort()) console.log(`  - ${p}  ${at.slice(0, 3).join(', ')}${at.length > 3 ? ` (+${at.length - 3})` : ''}`)
  if (strict) process.exitCode = 1
}

main(process.argv.slice(2))
