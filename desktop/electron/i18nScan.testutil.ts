/**
 * 主进程(desktop/electron)汉字字面量扫描器(P1-K5 I3)—— frontend/src/i18nCoverage.test.ts 的 M 段用它。
 *
 * 渲染层的 i18n 覆盖靠字典比对;主进程没有字典,文案要么写在 `{ zh, en }` 表 / 三元 / defineMainMessages 片段里,
 * 要么是硬编码中文。按 AST 把每个含汉字的字面量归一类:
 *   log       console.* / log(...) 等开发日志(CLAUDE.md:刻意留中文,不算违规)
 *   table     defineMainMessages( / registerMessages( 片段内
 *   bilingual `{ zh: …, en: … }` 表的 zh 分支内,或条件含 zh / locale 的三元内
 *   sink      原生界面出口(对话框、通知、托盘、菜单、窗口标题):**硬红**,必须改走 mt()
 *   debt      其余(IPC throw、HTTP detail、落盘名、脚本注释…):按文件计数进只许减少的欠账台账
 * 分类次序与原型 scan-han2.cjs 一致(基线 297408ab 实测:sink 15 / bilingual 46 / log 92 / debt 178 分布在 30 个文件)。
 *
 * 另外抽出:defineMainMessages 片段(静态取值,不 eval)、mt('k') / mtFor(l,'k') 的字面量键、以及每个
 * `{ zh, en }` 表的键集与 en 值(M4 核对)。
 */
import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HAN = /[一-龥]/
/** 原生出口调用(方法名结尾匹配:dialog.showMessageBox、tray.setToolTip、Menu.buildFromTemplate、win.setTitle …)。 */
const SINK_CALL = /(^|\.)(showMessageBox|showMessageBoxSync|showErrorBox|showOpenDialog|showOpenDialogSync|showSaveDialog|showSaveDialogSync|setToolTip|setContextMenu|buildFromTemplate|setAboutPanelOptions|setSaveDialogOptions|setTitle)$/
const SINK_NEW = /^(Notification|Tray|MenuItem|BrowserWindow)$/
const SINK_PROP = /^(title|buttons|label|sublabel|toolTip|checkboxLabel)$/
const LOG_CALL = /(^console\.\w+$)|(^|\.)(log|warn|error|info|debug)$/

export interface HanHit { file: string; line: number; text: string }
export interface BilingualTable {
  file: string
  line: number
  /** 'object' = zh/en 都是对象字面量(按键集递归核对);'string' = zh/en 都是字符串。 */
  shape: 'object' | 'string' | 'mixed'
  onlyZh: string[]
  onlyEn: string[]
  /** en 分支里含汉字的叶子(路径 = 值)。 */
  enHan: string[]
}
export interface MainFragmentEntry { zh?: string; en?: string; file: string; line: number }
export interface ElectronHanScan {
  /** 扫到的源文件(相对 root)。 */
  files: string[]
  sinks: HanHit[]
  logs: HanHit[]
  /** 走了双语机制的汉字字面量(zh 分支 / 三元 / 片段)。 */
  bilingual: HanHit[]
  /** 出现过双语机制的文件(M0 自检:tray / permissionGuide / desktopPermissions 必须在)。 */
  bilingualFiles: string[]
  /** 欠账:文件 → 命中。 */
  debt: Record<string, HanHit[]>
  tables: BilingualTable[]
  /** defineMainMessages 片段合并后的 key → 文案。 */
  fragments: Record<string, MainFragmentEntry>
  /** 同键不同文案 / 静态取不出值的片段条目。 */
  fragmentProblems: string[]
  mtKeys: Array<{ file: string; line: number; key: string }>
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p, out); continue }
    if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name) || /\.d\.ts$/.test(name) || /\.testutil\.ts$/.test(name)) continue
    out.push(p)
  }
  return out
}

const propName = (n: ts.PropertyName | undefined, sf: ts.SourceFile): string | null => {
  if (!n) return null
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return n.text
  return n.getText(sf)
}
/** 剥掉 `x as const` / `x satisfies T` / 括号,拿到里面的表达式。 */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
    else return e
  }
}
const staticString = (e: ts.Expression | undefined): string | null => {
  if (!e) return null
  const u = unwrap(e)
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : null
}
const findProp = (o: ts.ObjectLiteralExpression, name: string, sf: ts.SourceFile): ts.PropertyAssignment | undefined =>
  o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name, sf) === name)

/** 对象字面量 → 叶子路径表(值是字符串就记字符串,别的记 null)。 */
function leaves(o: ts.ObjectLiteralExpression, sf: ts.SourceFile, prefix = '', out = new Map<string, string | null>()): Map<string, string | null> {
  for (const p of o.properties) {
    if (!ts.isPropertyAssignment(p)) { out.set(`${prefix}${p.name ? propName(p.name as ts.PropertyName, sf) : '?'}`, null); continue }
    const k = `${prefix}${propName(p.name, sf)}`
    const v = unwrap(p.initializer)
    if (ts.isObjectLiteralExpression(v)) leaves(v, sf, `${k}.`, out)
    else out.set(k, staticString(v) ?? (ts.isTemplateExpression(v) ? v.getText(sf) : null))
  }
  return out
}

export function scanElectronHan(root: string): ElectronHanScan {
  const abs = walk(root)
  const res: ElectronHanScan = {
    files: abs.map((f) => relative(root, f)), sinks: [], logs: [], bilingual: [], bilingualFiles: [], debt: {},
    tables: [], fragments: {}, fragmentProblems: [], mtKeys: [],
  }
  const bilingualFiles = new Set<string>()
  for (const f of abs) {
    const rel = relative(root, f)
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
    const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const hit = (n: ts.Node): HanHit => ({ file: rel, line: lineOf(n), text: n.getText(sf).slice(0, 80).replace(/\n/g, ' ') })

    // 前置一趟:同一函数内 `const opts = {…}` 再按名字传进出口调用 —— 那个对象字面量整个算出口。
    const sinkObjs = new Set<ts.Node>()
    const pre = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && SINK_CALL.test(node.expression.getText(sf))) {
        for (const a of node.arguments) {
          if (!ts.isIdentifier(a)) continue
          let scope: ts.Node | undefined = node.parent
          while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent
          const find = (n: ts.Node): void => {
            if (ts.isVariableDeclaration(n) && n.name.getText(sf) === a.text && n.initializer && ts.isObjectLiteralExpression(unwrap(n.initializer))) sinkObjs.add(unwrap(n.initializer))
            ts.forEachChild(n, find)
          }
          if (scope) find(scope)
        }
      }
      ts.forEachChild(node, pre)
    }
    pre(sf)

    const visit = (node: ts.Node): void => {
      // ── mt / mtFor 的字面量键 ──
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf)
        const keyArg = callee === 'mt' ? node.arguments[0] : callee === 'mtFor' ? node.arguments[1] : undefined
        const key = staticString(keyArg)
        if (key !== null) res.mtKeys.push({ file: rel, line: lineOf(node), key })
        // ── defineMainMessages 片段 ──
        if (callee === 'defineMainMessages') {
          const arg = node.arguments[0] && unwrap(node.arguments[0])
          if (!arg || !ts.isObjectLiteralExpression(arg)) res.fragmentProblems.push(`${rel}:${lineOf(node)} defineMainMessages 的参数不是对象字面量(静态取不出键)`)
          else {
            for (const p of arg.properties) {
              if (!ts.isPropertyAssignment(p)) { res.fragmentProblems.push(`${rel}:${lineOf(p)} 片段条目不是 'key': { zh, en } 字面量`); continue }
              const k = propName(p.name, sf) ?? '?'
              const v = unwrap(p.initializer)
              const zh = ts.isObjectLiteralExpression(v) ? staticString(findProp(v, 'zh', sf)?.initializer) : null
              const en = ts.isObjectLiteralExpression(v) ? staticString(findProp(v, 'en', sf)?.initializer) : null
              if (zh === null && en === null) { res.fragmentProblems.push(`${rel}:${lineOf(p)} ${k} 的 zh / en 不是字符串字面量`); continue }
              const prev = res.fragments[k]
              if (prev && (prev.zh !== (zh ?? undefined) || prev.en !== (en ?? undefined))) {
                res.fragmentProblems.push(`${k} 同键不同文案:${prev.file}:${prev.line} 与 ${rel}:${lineOf(p)}`)
              }
              res.fragments[k] = { ...(zh !== null ? { zh } : {}), ...(en !== null ? { en } : {}), file: rel, line: lineOf(p) }
            }
          }
        }
      }
      // ── { zh, en } 表(M4)──
      if (ts.isObjectLiteralExpression(node)) {
        const zp = findProp(node, 'zh', sf), ep = findProp(node, 'en', sf)
        if (zp && ep) {
          const zv = unwrap(zp.initializer), ev = unwrap(ep.initializer)
          const t: BilingualTable = { file: rel, line: lineOf(node), shape: 'mixed', onlyZh: [], onlyEn: [], enHan: [] }
          if (ts.isObjectLiteralExpression(zv) && ts.isObjectLiteralExpression(ev)) {
            t.shape = 'object'
            const zl = leaves(zv, sf), el = leaves(ev, sf)
            t.onlyZh = [...zl.keys()].filter((k) => !el.has(k)).sort()
            t.onlyEn = [...el.keys()].filter((k) => !zl.has(k)).sort()
            for (const [k, v] of el) if (v && HAN.test(v)) t.enHan.push(`${k} = ${v.slice(0, 60)}`)
          } else if (staticString(zv) !== null || staticString(ev) !== null || ts.isTemplateExpression(ev) || ts.isTemplateExpression(zv)) {
            t.shape = 'string'
            const en = staticString(ev) ?? (ts.isTemplateExpression(ev) ? ev.getText(sf) : '')
            if (HAN.test(en)) t.enHan.push(`en = ${en.slice(0, 60)}`)
          }
          res.tables.push(t)
        }
      }
      // ── 含汉字的字面量归类 ──
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && HAN.test(node.getText(sf))) {
        let cls: 'log' | 'table' | 'bilingual' | 'sink' | null = null
        for (let q: ts.Node | undefined = node.parent; q; q = q.parent) {
          if (ts.isCallExpression(q) && LOG_CALL.test(q.expression.getText(sf))) { cls = 'log'; break }
          if (ts.isCallExpression(q) && /defineMainMessages|registerMessages/.test(q.expression.getText(sf))) { cls = 'table'; break }
          if (ts.isPropertyAssignment(q) && propName(q.name, sf) === 'zh' && ts.isObjectLiteralExpression(q.parent) && !!findProp(q.parent, 'en', sf)) { cls = 'bilingual'; break }
          if (ts.isConditionalExpression(q) && /\bzh\b|locale/.test(q.condition.getText(sf))) { cls = 'bilingual'; break }
        }
        if (!cls) {
          for (let q: ts.Node | undefined = node.parent, d = 0; q && d < 6; q = q.parent, d++) {
            if (ts.isCallExpression(q) && SINK_CALL.test(q.expression.getText(sf))) { cls = 'sink'; break }
            if (ts.isNewExpression(q) && SINK_NEW.test(q.expression.getText(sf))) { cls = 'sink'; break }
            if (ts.isPropertyAssignment(q) && SINK_PROP.test(propName(q.name, sf) ?? '')) { cls = 'sink'; break }
            if (sinkObjs.has(q)) { cls = 'sink'; break }
            if (ts.isBlock(q) || ts.isSourceFile(q)) break
          }
        }
        const h = hit(node)
        if (cls === 'sink') res.sinks.push(h)
        else if (cls === 'log') res.logs.push(h)
        else if (cls === 'table' || cls === 'bilingual') { res.bilingual.push(h); bilingualFiles.add(rel) }
        else (res.debt[rel] ||= []).push(h)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  res.bilingualFiles = [...bilingualFiles].sort()
  return res
}
