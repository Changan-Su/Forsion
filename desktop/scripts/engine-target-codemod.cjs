#!/usr/bin/env node
/**
 * P1-K6 S3 · 引擎服务调用点 codemod(规格 K6 §3.8 S3;INTEGRATION §2.1-4「每次重基都重跑,不手合 366 处调用」)。
 *
 * 把 backendService / agentRunService 的调用点从「传整份本端 cfg」改成「传目标解析层给的目标」:
 *   session 类(函数表 SESSION_SID,会话 id 在第几个实参)→ targetForSession(<会话 id 表达式>)
 *   appStore 的 `catalogArg(X)`(S2 的「焦点目录」包装)            → focusTarget()
 *   不是本端那份 cfg 的(对象字面量 / ADHOC_FILES 里经 waitBackend 拿的主进程配置)→ connectionTarget(<原表达式>)
 *   其余(home 类 + 管理面板里的 target 类,K6 待定 2/4:管理面恒打 home)  → homeTarget()
 * 不改、只报告(MANUAL):按 runId 的 run 类函数(会话 id 不在实参里,须人工写 targetForSession(sid))、
 *   会话 id 表达式不纯(复制两遍会重复求值)、实参是 `a ?? b` / 三元这类「来源不定」的表达式。
 *   Phase B(服务函数只收 EngineTarget)之后这些调用点 tsc 直接报错 —— 人工修完才能编译过,漏不掉。
 *
 * 判据用 TypeScript 类型检查器,不按文本猜:被调函数的声明在两个服务文件里、首个形参是引擎目标(EngineArg / EngineTarget),
 * 且实参类型**不是** EngineTarget(没有 `unitBase` 属性)。已经传目标的调用点原样跳过 → 可重复运行(幂等)。
 * 扫三份 tsconfig(desktop / mobile / web):mobile 与 web 的源码不在 desktop 的程序里。
 *
 * 用法(在 Genesis/desktop 下):
 *   node scripts/engine-target-codemod.cjs            改写源码(不含测试)
 *   node scripts/engine-target-codemod.cjs --dry      只报告
 *   node scripts/engine-target-codemod.cjs --tests    只改测试文件:一律包成 connectionTarget(<原实参>)(测试里的 cfg 是夹具)
 *   node scripts/engine-target-codemod.cjs --check    有剩余的旧式调用点就退出 1(不改文件)
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const GENESIS = path.resolve(__dirname, '../..')
const FE = 'desktop/frontend/src/'
const TARGETS_MOD = path.join(GENESIS, FE, 'services/engine/targets.ts')
const SERVICE_FILES = new Set(['services/backendService.ts', 'services/agentRunService.ts'].map((f) => path.join(GENESIS, FE, f)))
const TSCONFIGS = ['desktop/tsconfig.json', 'mobile/tsconfig.json', 'web/tsconfig.json']

const argv = new Set(process.argv.slice(2))
const DRY = argv.has('--dry') || argv.has('--check')
const TESTS = argv.has('--tests')

/** 会话类:函数名 → 会话 id 在第几个实参(0 = 目标本身)。字符串 'params.sessionId' = 第 1 个实参是对象字面量里的 sessionId。
 *  与 K6 §3.3 的 session 类同表(含五个 deny-remote 的:服务层按目标能力预判,不发请求)。 */
const SESSION_SID = {
  // backendService
  updateSession: 1, deleteSession: 1, branchSession: 1, getSessionDetail: 1, openTeamMemberSession: 1, getBackgroundSessions: 1,
  listMessages: 1, deleteMessages: 1, listCheckpoints: 1, restoreCheckpoint: 1, getSessionConfig: 1, putSessionConfig: 1,
  patchSessionConfig: 1, getSessionUsage: 1, getSessionTimeline: 1, compactSession: 1, getSessionHistorian: 1,
  listWorkspace: 1, readWorkspaceFile: 1, workspaceDownloadUrl: 1, downloadWorkspaceFile: 1, uploadWorkspaceFiles: 1, deleteWorkspaceFile: 1,
  // agentRunService
  listActiveRuns: 1, abortRunAndWait: 2, startRun: 'params.sessionId',
}
/** run 类(按 runId,会话 id 不在实参里):不改,报 MANUAL。调用点手里一定有会话 id(runningBySession / approval.sessionId …)。 */
const RUN_SCOPED = new Set(['abortRun', 'steerRun', 'expediteSteer', 'cancelSteer', 'resolveInquiry', 'sendUiAck', 'sendDeskCapture', 'resolveApproval', 'subscribeRunEvents'])
/** 这些文件里的 cfg 不是 appStore 那份,而是经 tanguSeam 探针 waitBackend() 现取的主进程配置(与 appStore 有 import 环,
 *  所在窗口也未必装了引擎宿主)→ 显式 connectionTarget(cfg),行为逐字不变。 */
const ADHOC_FILES = new Set([`${FE}amadeus/plugins/pluginStore.ts`, `${FE}tanguProbe.ts`])

const rel = (f) => path.relative(GENESIS, f).split(path.sep).join('/')
const isTest = (r) => /\.(test|spec)\.tsx?$/.test(r)
function inScope(r) {
  if (!(r.startsWith(FE) || r.startsWith('mobile/src/') || r.startsWith('web/src/'))) return false
  if (r.startsWith(`${FE}services/engine/`)) return false
  if (SERVICE_FILES.has(path.join(GENESIS, r))) return false
  if (r.endsWith('.d.ts')) return false
  return TESTS ? isTest(r) : !isTest(r)
}

function loadProgram(tsconfig) {
  const file = path.join(GENESIS, tsconfig)
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) } })
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
}

/** 纯表达式:可以安全地在同一处再求值一次(标识符、属性链、非空断言、括号;链根可以是 get() / useApp.getState())。 */
function isPure(n) {
  if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) return isPure(n.expression)
  if (ts.isIdentifier(n) || n.kind === ts.SyntaxKind.ThisKeyword) return true
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true
  if (ts.isPropertyAccessExpression(n)) return isPure(n.expression)
  if (ts.isElementAccessExpression(n)) return isPure(n.expression) && (ts.isStringLiteral(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression) || ts.isIdentifier(n.argumentExpression))
  if (ts.isCallExpression(n) && n.arguments.length === 0) {
    const t = n.expression.getText()
    return t === 'get' || t === 'useApp.getState'
  }
  return false
}

const isCatalogArgCall = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'catalogArg'

function main() {
  /** file → Map<start, {start,end,text}> */
  const edits = new Map()
  /** file → Set<import name> */
  const needs = new Map()
  const manual = []
  const stats = { session: 0, focus: 0, home: 0, adhoc: 0, skipped: 0 }
  const seen = new Set()
  let legacyLeft = 0

  const addEdit = (sf, node, text, name) => {
    const f = sf.fileName
    if (!edits.has(f)) edits.set(f, new Map())
    edits.get(f).set(node.getStart(sf), { start: node.getStart(sf), end: node.getEnd(), text })
    if (name) {
      if (!needs.has(f)) needs.set(f, new Set())
      needs.get(f).add(name)
    }
  }

  for (const cfgFile of TSCONFIGS) {
    const program = loadProgram(cfgFile)
    const checker = program.getTypeChecker()
    for (const sf of program.getSourceFiles()) {
      const r = rel(sf.fileName)
      if (sf.fileName.includes('node_modules') || !inScope(r)) continue
      const visit = (n) => {
        // appStore 的 S2 包装:catalogArg(X) → focusTarget()(无论它是不是直接当实参;定义处留给人工删)
        if (!TESTS && isCatalogArgCall(n)) {
          const key = `${sf.fileName}:${n.getStart(sf)}`
          if (!seen.has(key)) { seen.add(key); addEdit(sf, n, 'focusTarget()', 'focusTarget'); stats.focus++ }
          return
        }
        if (ts.isCallExpression(n) && n.arguments.length) check(n)
        ts.forEachChild(n, visit)
      }
      const check = (call) => {
        const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression
        let sym = checker.getSymbolAtLocation(callee)
        if (sym && (sym.flags & ts.SymbolFlags.Alias)) sym = checker.getAliasedSymbol(sym)
        const decl = sym?.declarations?.[0]
        if (!decl || !SERVICE_FILES.has(decl.getSourceFile().fileName)) return
        const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl
        const p0 = fn && fn.parameters && fn.parameters[0]
        const p0t = p0?.type?.getText()
        if (p0t !== 'EngineArg' && p0t !== 'EngineTarget') return
        const a0 = call.arguments[0]
        if (isCatalogArgCall(a0) && !TESTS) return // visit 走到它时改成 focusTarget()
        const key = `${sf.fileName}:${a0.getStart(sf)}`
        if (seen.has(key)) return
        seen.add(key)
        if (checker.getTypeAtLocation(a0).getProperty('unitBase')) { stats.skipped++; return } // 已是目标
        // 实参是由 catalogArg(...) 初始化的局部量(appStore connect 里的 `const target = catalogArg(c)`):那一处已改成 focusTarget()
        if (ts.isIdentifier(a0)) {
          const vd = checker.getSymbolAtLocation(a0)?.valueDeclaration
          if (vd && ts.isVariableDeclaration(vd) && vd.initializer && isCatalogArgCall(vd.initializer)) { stats.skipped++; return }
        }
        const name = sym.name
        const where = `${r}:${sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1}`
        legacyLeft++
        if (TESTS) { addEdit(sf, a0, `connectionTarget(${a0.getText(sf)})`, 'connectionTarget'); stats.adhoc++; return }
        if (ts.isObjectLiteralExpression(a0) || ADHOC_FILES.has(r)) { addEdit(sf, a0, `connectionTarget(${a0.getText(sf)})`, 'connectionTarget'); stats.adhoc++; return }
        if (ts.isBinaryExpression(a0) || ts.isConditionalExpression(a0)) { manual.push(`${where} ${name}(${a0.getText(sf)}, …) —— 实参来源不定(可能不是本端 cfg),人工判`); return }
        if (RUN_SCOPED.has(name)) { manual.push(`${where} ${name}(…) —— run 类,会话 id 不在实参里:改成 targetForSession(<会话 id>)`); return }
        const sidAt = SESSION_SID[name]
        if (sidAt !== undefined) {
          let sid = null
          if (sidAt === 'params.sessionId') {
            const o = call.arguments[1]
            if (o && ts.isObjectLiteralExpression(o)) {
              const p = o.properties.find((x) => x.name && x.name.getText(sf) === 'sessionId')
              if (p && ts.isShorthandPropertyAssignment(p)) sid = p.name
              else if (p && ts.isPropertyAssignment(p)) sid = p.initializer
            }
          } else sid = call.arguments[sidAt] || null
          if (!sid || !isPure(sid)) { manual.push(`${where} ${name}(…) —— 会话 id 表达式缺失或不纯:${sid ? sid.getText(sf) : '(无)'}`); return }
          addEdit(sf, a0, `targetForSession(${sid.getText(sf)})`, 'targetForSession')
          stats.session++
          return
        }
        addEdit(sf, a0, 'homeTarget()', 'homeTarget')
        stats.home++
      }
      visit(sf)
    }
  }

  // ── 落盘:从后往前替换,再补 import ──
  const files = [...new Set([...edits.keys()])].sort()
  for (const f of files) {
    let src = fs.readFileSync(f, 'utf8')
    const list = [...edits.get(f).values()].sort((a, b) => b.start - a.start)
    let floor = Infinity
    for (const e of list) {
      if (e.end > floor) throw new Error(`${rel(f)}: 改写区间重叠(${e.start}-${e.end}),人工处理`)
      src = src.slice(0, e.start) + e.text + src.slice(e.end)
      floor = e.start
    }
    src = addImports(f, src, needs.get(f) || new Set())
    if (!DRY) fs.writeFileSync(f, src)
  }

  const report = [
    `[engine-target-codemod] ${TESTS ? '测试文件' : '源码'}${DRY ? '(未写盘)' : ''}:改 ${files.length} 个文件 —— ` +
      `session ${stats.session} / focus ${stats.focus} / home ${stats.home} / connection ${stats.adhoc};已是目标跳过 ${stats.skipped}`,
    ...(manual.length ? [`  需人工(${manual.length}):`, ...manual.map((m) => `    ${m}`)] : []),
  ]
  console.log(report.join('\n'))
  if (argv.has('--verbose')) for (const f of files) console.log(`  ${rel(f)}: ${edits.get(f).size}`)
  if (argv.has('--check') && legacyLeft > 0) process.exit(1)
}

/** 往文件里补 import { …names } from '<targets>':已有同模块的值导入就并进去,否则在最后一条 import 后新起一行。 */
function addImports(file, src, names) {
  if (!names.size) return src
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const r = rel(file)
  const spec = r.startsWith(FE)
    ? (() => { let s = path.relative(path.dirname(file), TARGETS_MOD).split(path.sep).join('/').replace(/\.ts$/, ''); return s.startsWith('.') ? s : `./${s}` })()
    : '@/services/engine/targets'
  const imports = sf.statements.filter(ts.isImportDeclaration)
  const same = imports.find((d) => {
    const m = d.moduleSpecifier.text
    return (m === spec || m.endsWith('/services/engine/targets') || (r.startsWith(`${FE}services/`) && m === './engine/targets'))
      && d.importClause && !d.importClause.isTypeOnly && d.importClause.namedBindings && ts.isNamedImports(d.importClause.namedBindings)
  })
  if (same) {
    const nb = same.importClause.namedBindings
    const have = new Set(nb.elements.map((e) => e.name.text))
    const add = [...names].filter((n) => !have.has(n)).sort()
    if (!add.length) return src
    const at = nb.elements.length ? nb.elements[nb.elements.length - 1].getEnd() : nb.getStart(sf) + 1
    return src.slice(0, at) + (nb.elements.length ? ', ' : ' ') + add.join(', ') + src.slice(at)
  }
  const line = `import { ${[...names].sort().join(', ')} } from '${spec}'\n`
  const last = imports[imports.length - 1]
  if (!last) return line + src
  const at = last.getEnd()
  const nl = src.indexOf('\n', at)
  return nl < 0 ? `${src}\n${line}` : src.slice(0, nl + 1) + line + src.slice(nl + 1)
}

main()
