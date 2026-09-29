// i18n 覆盖仪器 —— 钉的是「切了英文界面还是中文」这一类**静默**故障。
//
// 病理:translateIn 的回退链是 `en[key] ?? zh[key] ?? key`。所以一个只加了 zh、忘了 en 的
// 键**不会报错、不会崩、不会红**,它只是在英文界面下原样渲染中文。人工点检基本抓不到
// (谁会把每一个界面都切成英文走一遍),只能靠字典比对。
//
// 三条断言:
//   A. zh 有的键 en 必须也有(反之亦然)
//   B. en 的值里不许出现汉字(= 没真翻,只是把中文抄过去了)
//   C. 源码里 t('literal') / translate('literal') 用到的键必须在字典里(动态键跳过)
//   I. 编辑器 / 嵌入层 / web·mobile 写通道的源码里,用户可见的字面量不许带汉字(JSX 文本、aria/title、报错与提示)
//
// 新增文案时这个文件红了,不要来这里加豁免 —— 去把 en 词条补上,那才是它存在的意义。
//
// M 段(P1-K5):主进程 desktop/electron 也纳入扫描(AST 扫描器 electron/i18nScan.testutil.ts)。
// 主进程自己撰写的原生界面文案(对话框 / 通知 / 托盘 / 选择框标题)一律走 mainI18n 的 mt() + defineMainMessages 片段;
// 片段并入下面的 zh / en 映射,A/B/E/F/G 自动覆盖。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import './i18n.generated' // 必须先注册,否则只看到 i18n.tsx 里的基础键
import { __dictSnapshot } from './i18n'
// LCL 引擎自带的文案表(宿主装配期 registerMessages 进来;见 lcl/engine/i18nSeam.ts)。纯字面量,直接 import。
import { LCL_MESSAGES } from '../../../lcl/engine/engineMessages'
// P1-K5:主进程汉字扫描器(不依赖 electron,只读源码做 AST)
import { scanElectronHan } from '../../electron/i18nScan.testutil'

const HAN = /[一-龥]/
const SRC = __dirname
/** 引擎源码:以前只扫 desktop,lcl 里的 t('…') / engineTr('…') 缺键没人管(U-45)。 */
const LCL_ENGINE = join(__dirname, '../../../lcl/engine')
/**
 * Web / 移动端的 Amadeus 写通道(评审 G2-14):以前完全不在扫描范围内,冲突 / 改名 / 报错提示写死中文没人管。
 * 它们与桌面渲染层同吃 `@/i18n`,片段(registerMessages)与键存在性(C)照同一套规则查。
 * ⚠️ 只并进 A/B/C/D/I;H/H2(日期格式)按 `relative(SRC, …)` 逐项登记,是桌面渲染层自己的账。
 */
const BRIDGE_ROOTS = [join(__dirname, '../../../web/src/amadeus'), join(__dirname, '../../../mobile/src/amadeus')]
/** P1-K5:主进程源码根(desktop/electron)。 */
const ELECTRON_ROOT = join(__dirname, '../../electron')
/** P1-K8:移动端自有源码根(mobile/src)。UnitsSheet 等模块级 registerMessages 片段、t('…') 用键此前不受检
 *  (「红了去补 en」的保障在移动端不存在);settingsHarness.tsx 是台架页,不进产品。 */
const MOBILE_SRC = join(__dirname, '../../../mobile/src')

/**
 * 15 个组件在**模块作用域**自带 `registerMessages({...})` 片段,只有 import 了那个组件才会进字典。
 * 测试里不能真 import(JSX / 模块级 DOM 依赖会炸),所以静态取出对象字面量再求值 ——
 * 片段清一色是 `'key': { zh: '…', en: '…' }` 的纯字面量,new Function 足够且不引入运行时依赖。
 * ⚠️ 这些片段同样可能缺 en,必须纳入 A/B 断言,漏收就等于给自己开了 15 个文件的后门。
 */
function collectFragments(files: string[]): { zh: Record<string, string>; en: Record<string, string>; scanned: number; conflicts: string[] } {
  const zh: Record<string, string> = {}
  const en: Record<string, string> = {}
  const owner: Record<string, string> = {}
  const conflicts: string[] = []
  let scanned = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    let at = text.indexOf('registerMessages(')
    while (at !== -1) {
      const open = text.indexOf('{', at)
      if (open === -1) break
      // 括号配平扫描(片段里没有字符串套 `}` 的情况,值都是简单字面量)
      let depth = 0, end = -1
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) { end = i; break }
      }
      if (end === -1) break
      try {
        const obj = new Function(`return (${text.slice(open, end + 1)})`)() as Record<string, { zh?: string; en?: string }>
        for (const [k, v] of Object.entries(obj)) {
          // 同一个键被两个文件用不同文案注册 = 后 import 的静默覆盖前者(两处界面有一处会显示错的文案)。
          if (typeof v?.zh === 'string' && k in zh && zh[k] !== v.zh) {
            conflicts.push(`${k}\n      ${owner[k]}: ${zh[k]}\n      ${relative(SRC, file)}: ${v.zh}`)
          }
          if (typeof v?.zh === 'string') { zh[k] = v.zh; owner[k] = relative(SRC, file) }
          if (typeof v?.en === 'string') en[k] = v.en
        }
        scanned++
      } catch { /* 求值不了的片段跳过,C 断言会把它的键报成缺失,不会假绿 */ }
      at = text.indexOf('registerMessages(', end)
    }
  }
  return { zh, en, scanned, conflicts }
}

const base = __dictSnapshot()
const ALL_SRC = walk(SRC)
const ENGINE_SRC = walk(LCL_ENGINE)
const BRIDGE_SRC = BRIDGE_ROOTS.flatMap((d) => walk(d)).filter((f) => !f.endsWith('.d.ts'))
// P1-K8
const MOBILE_FILES = walk(MOBILE_SRC).filter((f) => !f.endsWith('settingsHarness.tsx'))
/** 渲染层之外纳入扫描的源码(web / mobile 桥 + 移动端自有源码),去重:mobile/src/amadeus 两边都收。 */
const EXTRA_SRC = [...new Set([...BRIDGE_SRC, ...MOBILE_FILES])]
const frag = collectFragments([...ALL_SRC, ...EXTRA_SRC].filter((f) => readFileSync(f, 'utf8').includes('registerMessages(')))
const lclZh = Object.fromEntries(Object.entries(LCL_MESSAGES).map(([k, v]) => [k, v.zh]))
const lclEn = Object.fromEntries(Object.entries(LCL_MESSAGES).map(([k, v]) => [k, v.en]))
/** 渲染层看得见的字典(C 段按它核对 t('…'):主进程片段的键在渲染层取不到,不许让它们替渲染层的缺键打掩护)。 */
const rendererZh: Record<string, string> = { ...base.zh, ...frag.zh, ...lclZh }
const rendererEn: Record<string, string> = { ...base.en, ...frag.en, ...lclEn }
// P1-K5:主进程 defineMainMessages 片段并进来 —— A/B/E/F/G 对它们一视同仁。
const electron = scanElectronHan(ELECTRON_ROOT)
const mainZh = Object.fromEntries(Object.entries(electron.fragments).filter(([, v]) => typeof v.zh === 'string').map(([k, v]) => [k, v.zh as string]))
const mainEn = Object.fromEntries(Object.entries(electron.fragments).filter(([, v]) => typeof v.en === 'string').map(([k, v]) => [k, v.en as string]))
const zh = { ...rendererZh, ...mainZh }
const en = { ...rendererEn, ...mainEn }

/** 值里带汉字却**故意**如此的键:产品名/品牌/中文专有名词在英文界面下也该保持原样。 */
const EN_MAY_CONTAIN_HAN = new Set<string>([
  'locale.zh', // 语言切换器里的语言名:英文界面下也该写「中文」,不是漏翻
])

/**
 * I 断言的桌面侧范围:v4 编辑器 + 嵌入层(embedLayer 的独立 React 根里挂的那几个组件)+ 查找条 + 图标库。
 * ⚠️ blocks/database 刻意不在内(多维表另有审计):「属性 / 状态 / 日期」是笔记视图的 frontmatter 键身份,
 *    `#错误` / `#循环` 是公式哨兵,`修改时间` / `人员` 有逐字断言 —— 不能按界面文案直接翻,单独立项。
 */
const EDITOR_SCOPE = [
  'amadeus/unified', 'amadeus/blocks/markdown', 'amadeus/blocks/button', 'amadeus/blocks/plugin', 'amadeus/blocks/excalidraw',
  'amadeus/components/BookmarkCard.tsx', 'amadeus/components/MediaPlayer.tsx', 'amadeus/components/WebEmbed.tsx',
  'amadeus/lib/emoji.ts', 'amadeus/plugins/components/OutlinePanel.tsx', 'findInPage.tsx',
]
/** 范围内的非产品文件:台架(UnifiedSpike 是 `?unified` spike,不进生产)。 */
const EDITOR_SKIP = new Set(['amadeus/unified/UnifiedSpike.tsx'])
/** I / I2 的扫描范围:编辑器 / 嵌入层(EDITOR_SCOPE)+ 两个写通道。 */
const I_SRC = [
  ...ALL_SRC.filter((f) => {
    const rel = relative(SRC, f)
    return !EDITOR_SKIP.has(rel) && EDITOR_SCOPE.some((s) => rel === s || rel.startsWith(`${s}/`))
  }),
  ...BRIDGE_SRC,
]

/**
 * 汉字字面量里**刻意**留中文的形态(CLAUDE.md「刻意留中文」一栏),只按 AST 上下文认,不按文件豁免 ——
 * 按文件豁免会把同文件里真正的界面文案一起放过去(emoji.ts 的分组名就是这么漏的,C-15)。
 *   · `zh:` 词条值(registerMessages 片段 / 双语表)
 *   · 模糊搜索的中文 / 拼音别名:属性名 kw / keywords / words / aliases,变量名 *KEYWORDS / *_WORDS
 *   · emoji 库每条 `[emoji, 关键词]` 元组的第二项(`items: [[…, '关键词'], …]`)
 *   · console.* 开发日志、正则(`new RegExp('[一-龥]')`)
 */
const HAN_OK_PROPS = new Set(['zh', 'kw', 'keywords', 'words', 'aliases'])
const HAN_OK_VARS = /(?:KEYWORDS|_WORDS)$/
function hanExempt(lit: ts.Node): boolean {
  const pa = lit.parent
  // emoji 元组:items: [[emoji, '关键词'], …]
  if (pa && ts.isArrayLiteralExpression(pa) && pa.elements.length === 2 && pa.elements[1] === lit) {
    const list = pa.parent
    const prop = list?.parent
    if (list && ts.isArrayLiteralExpression(list) && prop && ts.isPropertyAssignment(prop) && prop.name.getText() === 'items') return true
  }
  for (let n: ts.Node | undefined = lit.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isPropertyAssignment(n) && HAN_OK_PROPS.has(n.name.getText().replace(/['"]/g, ''))) return true
    if (ts.isVariableDeclaration(n)) return HAN_OK_VARS.test(n.name.getText())
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression.getText()
      if (/^console\./.test(callee) || callee === 'RegExp') return true
    }
    // 出了表达式就停:语句 / 函数体 / 类成员不再往上找豁免上下文
    if (ts.isStatement(n) || ts.isFunctionLike(n) || ts.isClassElement(n)) return false
  }
  return false
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'assets' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p, out); continue }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue
    if (name === 'i18n.tsx' || name === 'i18n.generated.ts') continue
    out.push(p)
  }
  return out
}

describe('i18n 覆盖', () => {
  it('0. 仪器自检:模块级 registerMessages 片段确实被收进来了', () => {
    // 防假绿:collectFragments 若因格式变化一个都没解析出来,A/B/C 会全绿但什么都没查。
    expect(frag.scanned, '一个 registerMessages 片段都没解析出来 —— 仪器已失效,先修解析').toBeGreaterThanOrEqual(15)
    expect(Object.keys(frag.zh).length).toBeGreaterThan(100)
  })

  it('0c. 仪器自检:移动端源码(mobile/src)确实被扫到,UnitsSheet 的片段被收进来了(P1-K8)', () => {
    expect(MOBILE_FILES.length, 'mobile/src 一个源文件都没扫到 —— 路径变了先来改 MOBILE_SRC').toBeGreaterThan(8)
    expect(MOBILE_FILES.some((f) => f.endsWith('settingsHarness.tsx')), '台架页不该进扫描').toBe(false)
    expect(frag.zh['unitm.runOn'], 'UnitsSheet 的 registerMessages 片段没被解析出来').toBeTruthy()
  })

  it('0b. 仪器自检:引擎源码与引擎文案表确实被收进来了', () => {
    expect(ENGINE_SRC.length, 'lcl/engine 一个源文件都没扫到 —— 路径变了先来改 LCL_ENGINE').toBeGreaterThan(20)
    expect(Object.keys(LCL_MESSAGES).length).toBeGreaterThan(20)
  })

  it('D2. 引擎文案表的键不与宿主字典撞车(撞了 registerMessages 会静默改掉宿主那条)', () => {
    const clash = Object.keys(LCL_MESSAGES).filter((k) => k in base.zh || k in frag.zh).sort()
    expect(clash, `引擎键与宿主键同名:\n    ${clash.join('\n    ')}`).toEqual([])
  })

  it('D. 没有两个文件用同一个键注册不同文案(并行加词条时的静默互踩)', () => {
    expect(frag.conflicts, `同键不同文案,后加载者会覆盖前者:\n    ${frag.conflicts.join('\n    ')}`).toEqual([])
    // 片段键与 i18n.tsx 基础字典撞车同理:片段会盖掉基础词条。
    const vsBase = Object.keys(frag.zh).filter((k) => k in base.zh && base.zh[k] !== frag.zh[k]).sort()
    expect(vsBase, `片段覆盖了 i18n.tsx 的基础词条:\n    ${vsBase.join('\n    ')}`).toEqual([])
  })

  it('A. zh 与 en 键集完全一致(缺 en = 英文界面静默显示中文)', () => {
    const missingEn = Object.keys(zh).filter((k) => !(k in en)).sort()
    const missingZh = Object.keys(en).filter((k) => !(k in zh)).sort()
    expect(missingEn, `这些键只有中文,英文界面会原样渲染中文:\n  ${missingEn.join('\n  ')}`).toEqual([])
    expect(missingZh, `这些键只有英文:\n  ${missingZh.join('\n  ')}`).toEqual([])
  })

  it('B. en 词条里不含汉字(= 确实翻过,不是把中文抄过去)', () => {
    const notTranslated = Object.entries(en)
      .filter(([k, v]) => !EN_MAY_CONTAIN_HAN.has(k) && HAN.test(v))
      .map(([k, v]) => `${k} = ${v}`)
      .sort()
    expect(notTranslated, `en 词条仍含中文:\n  ${notTranslated.join('\n  ')}`).toEqual([])
  })

  it('C. 源码里用到的字面量键都在字典里(缺键会把 key 本身渲染出来)', () => {
    // t('a.b') / translate('a.b') / tr('a.b');只收字面量,模板串与变量键跳过(静态判不了)。
    const USE = /\b(?:t|tr|translate|engineTr)\(\s*(['"])([\w.-]+)\1/g
    const unknown = new Map<string, string[]>()
    for (const file of [...ALL_SRC, ...ENGINE_SRC, ...EXTRA_SRC]) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(USE)) {
        const key = m[2]
        // 只认带点的命名空间键;`t('x')` 这种单词多半是别的同名函数(误报源)。
        if (!key.includes('.')) continue
        if (key in rendererZh || key in rendererEn) continue
        const list = unknown.get(key) ?? []
        list.push(relative(SRC, file))
        unknown.set(key, list)
      }
    }
    const report = [...unknown.entries()].map(([k, files]) => `${k}  <- ${[...new Set(files)].join(', ')}`).sort()
    expect(report, `字典里没有这些键,界面会直接渲染键名:\n  ${report.join('\n  ')}`).toEqual([])
  })

  it('I. 编辑器 / 嵌入层 / web·mobile 写通道:用户可见字面量不含汉字(C-14 / C-15 / R-15 / G2-14)', () => {
    // A/B/C 只看字典,JSX 里的裸文本、aria-label / title 字面量、`throw new Error('中文')`、toast 串它们看不见 ——
    // 链接悬停卡、emoji 分组名、插件预览空态、web / 移动端写通道的冲突提示就是这样一直漏着的(评审 C-14 / C-15 / G2-14)。
    // 红了:界面文案走 t() / translate() + registerMessages 成对登记;落盘产物命名走 translate('amadeus.default.*');
    // 确属搜索别名 / 日志 / 正则就按上面 hanExempt 的上下文写(别往这里加文件豁免)。
    const files = I_SRC
    const bad: string[] = []
    let exempted = 0
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const visit = (n: ts.Node): void => {
        const lit = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n)
          || ts.isTemplateTail(n) || ts.isJsxText(n)
        if (lit && HAN.test(n.text)) {
          if (hanExempt(n)) exempted++
          else bad.push(`${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}  ${JSON.stringify(n.text.trim().slice(0, 40))}`)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    // 仪器自检(防空跑全绿):范围确实扫到了编辑器 / 嵌入层 / 两个写通道;豁免分支确实走到过(slash 的 kw、emoji 关键词)。
    const rels = files.map((f) => relative(SRC, f))
    for (const must of ['amadeus/unified/linkCard.tsx', 'amadeus/unified/embedLayer.tsx', 'amadeus/blocks/markdown/MarkdownBlock.tsx', 'amadeus/lib/emoji.ts']) {
      expect(rels, `I 的扫描范围漏了 ${must} —— 目录挪了先来改 EDITOR_SCOPE`).toContain(must)
    }
    expect(BRIDGE_SRC.some((f) => f.endsWith('web/src/amadeus/cloudBridge.ts')), 'web 写通道没扫到').toBe(true)
    expect(BRIDGE_SRC.some((f) => f.endsWith('mobile/src/amadeus/mobileAmadeusBridge.ts')), '移动端写通道没扫到').toBe(true)
    expect(exempted, '一条豁免都没命中 —— hanExempt 失效了,I 断言在空跑').toBeGreaterThan(100)
    expect(bad, `用户可见字面量里有汉字(英文界面会原样显示中文):\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('I2. 同一范围里 aria-label / title / placeholder / alt 不许写死字面量(查找条的 aria 曾写死英文,C-14)', () => {
    // I 只管汉字;写死的英文同样是单语(中文界面下读屏念出 previous match)。命令式 DOM 的
    // `setAttribute('aria-label', '…')` / `el.title = '…'` 一并查。刻意保留的逐条登记理由。
    const ALLOW: Record<string, string> = {
      'amadeus/unified/UnifiedPage.tsx  placeholder="New Page"': '标题占位 New Page 是已定口径(手册写明,评审附录 A · C-15)',
    }
    const ATTR = /^(aria-label|title|placeholder|alt)$/
    const found: string[] = []
    const bad: string[] = []
    for (const file of I_SRC) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const hit = (n: ts.Node, what: string): void => {
        const key = `${relative(SRC, file)}  ${what}`
        found.push(key)
        if (!ALLOW[key]) bad.push(`${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}  ${what}`)
      }
      const lettered = (e: ts.Node | undefined): boolean =>
        !!e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && /[A-Za-z]/.test(e.text)
      const visit = (n: ts.Node): void => {
        if (ts.isJsxAttribute(n) && ATTR.test(n.name.getText()) && n.initializer) {
          const v = ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer
          if (lettered(v)) hit(n, n.getText())
        } else if (ts.isCallExpression(n) && /\.setAttribute$/.test(n.expression.getText()) && n.arguments.length === 2
          && ts.isStringLiteral(n.arguments[0]) && ATTR.test(n.arguments[0].text) && lettered(n.arguments[1])) {
          hit(n, n.getText())
        } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && /\.(title|placeholder|alt|ariaLabel)$/.test(n.left.getText()) && lettered(n.right)) {
          hit(n, n.getText())
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    const stale = Object.keys(ALLOW).filter((k) => !found.includes(k))
    expect(stale, `登记了但源码里已经没有的项(删掉登记):\n  ${stale.join('\n  ')}`).toEqual([])
    expect(bad, `写死的 aria / title / placeholder(换 t() / translate()):\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('G. 术语表:zh 不许出现已收口的旧叫法(U-27,见 genesis-ui skill「术语表」)', () => {
    // Agent 这个概念一律写「Agent」;Space 这个容器一律写「Space」;Agents 这个 Space 就叫「Agents」;
    // 「工作区」只指工作目录 / 项目文件夹;「工作空间」不再使用(指整个 app 时直接写 Forsion 或改写)。
    const BANNED: Array<{ re: RegExp; fix: string; allow?: Record<string, string> }> = [
      { re: /智能体/, fix: '写「Agent」' },
      // zh 里 Agent 是专名,一律大写;`manage_agent`、`{agent}`、`agent=xx`、`.agents/` 这类代码 / 占位符不算。
      { re: /(^|[^A-Za-z_{=./-])agents?(?=[^A-Za-z_}=/-]|$)/, fix: '写「Agent」(专名大写)' },
      { re: /工作空间/, fix: '指 Space 写「Space」,指整个 app 写「Forsion」或改写,指目录写「工作区」' },
      { re: /Agent Space|Agents space|智能体空间/, fix: 'Agents 这个 Space 就叫「Agents」' },
      // 09-26 用户拍板(UI/UX 走查 W-09 / W-19):侧栏那个文件夹对象叫「项目」;笔记库 / Vault 在中文里叫「智库」;数据库叫「多维表」。
      { re: /(默认|本地|重命名|移除|添加本地|筛选)工作区/, fix: '文件夹对象写「项目」(「工作区」只指工作区面板与可写范围)' },
      { re: /笔记库|本地库|云端库|(?<![\w/-])[Vv]ault(?![\w/-])/, fix: '写「智库」(en 仍是 vault)' },
      { re: /数据库/, fix: '写「多维表」' },
      {
        re: /空间/, fix: '指 Space 这个容器时写「Space」',
        allow: {
          'autocompact.hint': '「腾出空间」= 上下文余量,不指 Space',
          'imageStudio.ai.hint.expand': '「留出空间」= 画布四周的空白,不指 Space',
        },
      },
    ]
    const bad: string[] = []
    for (const [k, v] of Object.entries(zh)) {
      for (const b of BANNED) if (b.re.test(v) && !b.allow?.[k]) bad.push(`${k} = ${v}  → ${b.fix}`)
    }
    for (const [k, v] of Object.entries(en)) if (/Agent Space|Agents space/.test(v)) bad.push(`${k}(en) = ${v}  → Agents 这个 Space 写 "Agents" / "the Agents Space"`)
    expect(bad.sort(), `术语没收口:\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('F. zh 词条不是纯拉丁文(U-30:中文界面残留英文),品牌 / 专名 / 格式串逐条登记理由', () => {
    // 术语表里「zh 不译」的专名:由这些词拼成的 zh 值算合规(如「Agent」「Space ×{n}」「Muse Space」)。
    // ⚠️ 复数 Agents / Spaces 不在这里:它们只在作 Space 名时合规,见下面逐键登记。
    // Note 不在这里:笔记 Space 自 09-26 起中文写「笔记」(W-75)。
    const TERMS = new Set([
      'Agent', 'Space', 'MCP', 'Hooks', 'Git', 'AI', 'Python', 'Vault', 'Sandbox', 'Provider', 'ID', 'URL', 'HTTP', 'SSE', 'DEV', 'P2P',
      'Forsion', 'Tangu', 'Muse', 'Amadeus', 'Chat', 'Work', 'Desk', 'QQ', 'Telegram', 'OpenAI', 'Codex', 'OpenCode', 'Claude', 'Code',
      'CosyVoice', 'JetBrains', 'Mono', 'Hack2Gate', 'English', 'Computer', 'Use', 'Bot', 'Token', 'tokens',
    ])
    // 逐键登记:不是由术语拼成、但刻意保留拉丁文的值。
    const ALLOW: Record<string, string> = {
      'achievements.a.first-login.title': '成就标题,化用论文名的英文梗',
      'achievements.a.first-message.title': '成就标题,英文梗',
      'agentProfile.space': 'Space 名「Agents」(与 Spaces 同为专名)',
      'onboarding.guide.moreAgentsPath': '指向 Space 名「Agents」',
      'home.spaces': '「Spaces」是主页 Space 架的专名(U-27 拍板 #1 的先例)',
      'approvalRules.allowPh': '工具名示例(代码),不可译',
      'approvalRules.askPh': '工具名示例(代码),不可译',
      'approvalRules.denyPh': '工具名示例(代码),不可译',
      'team.editor.docPlaceholder': 'TEAM.md 骨架,给模型读的 Markdown 标题',
      'settings.developer.cloudUrlPlaceholder': 'URL 示例',
      'pill.ultra': '思考档位 Ultra 是对标 Codex Ultra 的模式专名(同 Chat / Work 不译),用户口径即「Ultra」',
      'input.thinkingShort.off': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
      'input.thinkingShort.minimal': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
      'input.thinkingShort.low': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
      'input.thinkingShort.medium': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
      'input.thinkingShort.high': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
      'input.thinkingShort.xhigh': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
      'input.thinkingShort.max': '思考档位各档名中文界面也写英文(09-27 用户拍板:与 Codex / 模型厂商的档名一致)',
    }
    const bad: string[] = []
    for (const [k, v] of Object.entries(zh)) {
      if (HAN.test(v) || !/[A-Za-z]/.test(v) || ALLOW[k]) continue
      const words = v.replace(/\{\w+\}/g, ' ').match(/[A-Za-z][A-Za-z0-9]*/g) ?? []
      if (words.every((w) => TERMS.has(w))) continue
      bad.push(`${k} = ${v}`)
    }
    expect(bad.sort(), `zh 值是纯英文:翻成中文,或确属品牌 / 专名就进 TERMS / ALLOW 并写明理由:\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('E. zh 标点(U-32):半角 , ; : ( ) ? ! 不许紧挨汉字', () => {
    // 规则见 genesis-ui skill「中文标点」:句内全角;{var}、反引号代码、URL、路径、快捷键、HH:mm 除外。
    // 红了跑 `node scripts/zh-punct.codemod.cjs`(幂等,与这里同一套排除;amadeus.default.* 是落盘命名,脚本不碰)。
    const strip = (v: string): string => v
      .replace(/\{\w+\}/g, '□')
      .replace(/`[^`]*`/g, '□')
      .replace(/https?:\/\/\S+/g, '□')
      .replace(/(?:~|\.{1,2})?\/[\w./*~-]+/g, '□')
      .replace(/(?:⌘|Ctrl|Cmd|Shift|Alt|Option|Meta)[+\w⇧⌥⌘,.]*/g, '□')
      .replace(/\d{1,2}:\d{2}/g, '□')
      .replace(/!\[\[?/g, '□')
      .replace(/!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '□') // Markdown 链接语法示例(目标里允许一层括号,同 codemod)
    const PUNCT = /[一-龥][,;:()?!]|[,;:()?!][一-龥]/
    const bad = Object.entries(zh).filter(([k, v]) => !k.startsWith('amadeus.default.') && PUNCT.test(strip(v))).map(([k, v]) => `${k} = ${v.slice(0, 60)}`)
    expect(Object.keys(zh).length).toBeGreaterThan(1000) // 防假绿:扫描确实跑过
    expect(bad, `zh 词条里半角标点紧挨汉字,跑 node scripts/zh-punct.codemod.cjs:\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('H. 日期 / 时间显示只走 format/time.ts 单源(U-29:不许再跟系统区域走)', () => {
    // 硬断言覆盖两类可静态判定的写法:toLocaleDateString / toLocaleTimeString,以及 new Intl.DateTimeFormat /
    // new Intl.RelativeTimeFormat。裸 `.toLocaleString()` 数字也在用(千分位),静态分不清,所以只拦
    // `new Date(…).toLocaleString(` 这一种明确是日期的形状;其余(变量接收者)由下面 H2 逐项登记兜住。
    // `Intl.DateTimeFormat().resolvedOptions()` 取本机时区不是格式化,不在拦截范围(不带 new)。
    const BAD = /\btoLocale(?:Date|Time)String\(|new Intl\.(?:DateTimeFormat|RelativeTimeFormat)\(|new Date\([^()]*\)\.toLocaleString\(/
    const TIME_SRC = join(SRC, 'format', 'time.ts')
    const hits: string[] = []
    for (const file of [...ALL_SRC, ...ENGINE_SRC]) {
      if (file === TIME_SRC) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (BAD.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits, `这些地方绕过了 format/time.ts(不传 locale = 跟系统区域走,中文界面会冒出 17/09/2026):\n  ${hits.join('\n  ')}`).toEqual([])
  })

  it('H2. 任何 `x.toLocaleString(` 都要逐项登记(Codex 第三轮 R2-e2-2)', () => {
    // H 只拦得住 `new Date(…).toLocaleString(`;先赋给变量再 `at.toLocaleString()` 就漏过去,照样随系统区域显示日期。
    // 静态分不清接收者是日期还是数字,所以反过来:**全部**调用都按「文件 + 接收者表达式」登记,只放行确认是数字
    // (千分位)的那几处,并写明理由。新增的一律变红 —— 是日期就改走 format/time.ts,是数字就来这里登记。
    // 每项还记**次数**:只按「文件 + 接收者」放行时,同文件再来一个同名接收者(如 DatabaseEmbed 里另一个 `v` 是日期)
    // 会被已有登记顺手放过;次数对不上即红,新增的那处得自己来登记。
    const NUMBER_OK: Record<string, [count: number, reason: string]> = {
      'stores/appStore.ts  Math.round(runCost)': [1, '单次运行费用(数字千分位)'],
      'stores/appStore.ts  costLimit': [1, '费用上限(数字)'],
      'stores/appStore.ts  (Number(pl.savedChars) || 0)': [1, '压缩省下的字数(数字)'],
      'components/FeedbackModal.tsx  text.trim().length': [1, '反馈字数(数字)'],
      'components/FeedbackModal.tsx  FEEDBACK_TEXT_LIMIT': [1, '字数上限常量(数字)'],
      'components/ModelPickerSettings.tsx  model.maxContextWindow!': [1, '上下文窗口上限(token 数)'],
      'components/ModelPickerSettings.tsx  (model.contextWindow ?? 0)': [1, '上下文窗口(token 数)'],
      'views/AgentProfileView.tsx  s.usage.ctx': [1, '上下文 token 数'],
      'views/chat2/Composer2.tsx  (sessionTokens ?? 0)': [2, '会话 token 数'],
      'views/chat2/Composer2.tsx  (ctxTokens ?? 0)': [1, '上下文 token 数'],
      'views/chat2/Composer2.tsx  (ringWindow ?? 0)': [1, '上下文窗口(token 数;Ultra 切换后按下一轮口径)'],
      'views/chat2/Composer2.tsx  Math.round(runCost)': [2, '单次运行费用(数字)'],
      'views/chat2/Composer2.tsx  costLimit': [2, '费用上限(数字)'],
      'views/chat2/ContextUsagePop.tsx  Math.round(runCost)': [1, '单次运行费用(数字)'],
      'views/chat2/ContextUsagePop.tsx  costLimit': [1, '费用上限(数字)'],
      'views/chat2/Composer2.tsx  outgoing.length': [1, '输入字数(数字)'],
      'views/chat2/Composer2.tsx  MAX_INPUT_CHARS': [1, '输入字数上限常量(数字)'],
      'amadeus/blocks/database/DatabaseEmbed.tsx  number': [1, '数字列的纯文本值(前面已判 number !== null)'],
      'amadeus/blocks/database/DatabaseEmbed.tsx  v': [1, '数字列的纯文本值(前面已判 typeof v === \'number\')'],
    }
    const TIME_SRC = join(SRC, 'format', 'time.ts')
    /** 从 `.toLocaleString(` 往回取接收者表达式:标识符 / 成员访问 / `!` / 成对括号(`Math.round(x)`、`(a ?? 0)`)。 */
    const receiverBefore = (line: string, dot: number): string => {
      let i = dot - 1
      while (i >= 0) {
        const c = line[i]
        if (c === ')') {
          let depth = 0
          for (; i >= 0; i--) {
            if (line[i] === ')') depth++
            else if (line[i] === '(' && --depth === 0) break
          }
          i--
          continue
        }
        if (/[\w$.!]/.test(c)) { i--; continue }
        break
      }
      return line.slice(i + 1, dot)
    }
    const found: string[] = []
    const bad: string[] = []
    for (const file of [...ALL_SRC, ...ENGINE_SRC]) {
      if (file === TIME_SRC) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        for (const m of line.matchAll(/\.toLocaleString\(/g)) {
          const key = `${relative(SRC, file)}  ${receiverBefore(line, m.index!)}`
          found.push(key)
          if (!NUMBER_OK[key]) bad.push(`${relative(SRC, file)}:${i + 1}  ${key.split('  ')[1]}  ← ${line.trim().slice(0, 100)}`)
        }
      })
    }
    // 防假绿:扫描确实命中了已登记的调用;登记表里的每一项都还在用(删了就把登记也删掉,别留死条目)。
    expect(found.length).toBeGreaterThan(0)
    const stale = Object.keys(NUMBER_OK).filter((k) => !found.includes(k))
    const tally = new Map<string, number>()
    for (const k of found) tally.set(k, (tally.get(k) ?? 0) + 1)
    const miscount = Object.entries(NUMBER_OK).filter(([k, [n]]) => tally.has(k) && tally.get(k) !== n).map(([k, [n]]) => `${k}  登记 ${n} 处,源码 ${tally.get(k)} 处`)
    expect(stale, `登记了但源码里已经没有的项(删掉登记):\n  ${stale.join('\n  ')}`).toEqual([])
    expect(miscount, `登记次数与源码不符 —— 多出来的那处先确认接收者是数字(是日期改走 format/time.ts),再改次数:\n  ${miscount.join('\n  ')}`).toEqual([])
    expect(bad, `未登记的 .toLocaleString( —— 是日期就改走 format/time.ts;确认是数字就进 NUMBER_OK 并写明理由:\n  ${bad.join('\n  ')}`).toEqual([])
  })
})

// ── P1-K5:主进程(desktop/electron)的 M 段 ────────────────────────────────────────────────────────
/**
 * M5 欠账台账:主进程里**日志、双语表、原生出口之外**剩下的汉字字面量,按文件记数(与 H2 的 NUMBER_OK 同形)。
 * ⚠️ 只许减少,不是豁免表:新增的文案改成原因码(frontend/src/ipcError.ts 的约定,界面按码翻译)或 mt();
 * 改掉一处就把这里的数减一(数多了红、数少了也红 —— 逼着台账跟着降)。红了别来加豁免,那违背 CLAUDE.md「红了去补 en」。
 * 初值 = 基线 297408ab 实测 178 处 / 30 个文件。
 */
const ELECTRON_HAN_DEBT: Record<string, [count: number, reason: string]> = {
  'main.ts': [36, 'IPC throw new Error(中文):渲染层原样显示;按 ipcError.ts 原因码约定,各包碰到时改码'],
  'unitWeb.ts': [23, 'HTTP JSON detail(已带 code,设备页按 code 翻译)+ 未配对页的内联 HTML'],
  'amadeus/fs/vaultHandlers.ts': [14, '笔记 IPC 的校验错误(throw),渲染层原样显示;待改原因码'],
  'unitP2p.ts': [11, 'P2P 代理的 HTTP 错误 detail / 信道断开原因(throw)'],
  'p2pWindow.ts': [9, 'P2P 打洞 / 信道状态的 Error 文案(调用方只拿来记日志与回落中转)'],
  'amadeus/ipc.ts': [3, '示例插件模板(落盘文件内容)、插件 id 的 IPC 错误'],
  'asrLocal.ts': [6, '本地语音模型下载 / 加载的 Error 文案'],
  'cliInstall.ts': [6, '生成的 tangu CLI shell 脚本注释(落盘内容)与 CLI 安装错误'],
  'netGuard.ts': [6, '订阅地址校验的 Error 文案(日历订阅 IPC)'],
  'builtinPlugins.ts': [5, '内置包来源的诊断标签(日志 / 状态说明)'],
  'backendManager.ts': [4, '引擎启动失败的 Error / lastError 文案'],
  'codePreview.ts': [4, '预览根的诊断标签'],
  'seedThemes.ts': [4, '种子主题的名称 / 描述 / CSS 注释(落盘的主题包内容,主题 id 永不改)'],
  'amadeus/linkMeta.ts': [2, '链接卡片元数据里的站点名(哔哩哔哩)'],
  'configWrite.ts': [2, '配置写锁超时的 Error 文案'],
  'hostTextWrite.ts': [2, '写文件 IPC 的 Error 文案'],
  'marketInstall.ts': [2, '市场压缩包校验的 Error 文案'],
  'minitar.ts': [2, 'tar 解包的 Error 文案'],
  'remotesync/fsWebdav.ts': [2, 'WebDAV 同步的 Error 文案'],
  'asr.ts': [1, '云端转写失败的 Error 文案'],
  'pty.ts': [1, '终端不可用的 Error 文案'],
  'remotesync/engine.ts': [1, '同步中止原因(带原因码前缀 remote-empty-suspicious)'],
  'remotesync/fsDropbox.ts': [1, 'OAuth 回调页的双语 HTML 正文'],
  'remotesync/fsS3.ts': [1, 'S3 配置错误提示'],
}

describe('M. 主进程(desktop/electron)i18n —— P1-K5', () => {
  it('M0. 仪器自检:electron 源码确实被扫到,已知的双语机制都认得出来', () => {
    // 防假绿:根路径指错 / 扫描器坏了,M3–M5 会全绿但什么都没查。
    expect(electron.files.length, `只扫到 ${electron.files.length} 个 electron 源文件 —— ELECTRON_ROOT 指错了?`).toBeGreaterThanOrEqual(80)
    for (const f of ['tray.ts', 'permissionGuide.ts', 'desktopPermissions.ts', 'mainMessages.ts']) {
      expect(electron.bilingualFiles, `${f} 的 {zh,en} 表 / 语言三元 / defineMainMessages 片段没被认出来 —— 扫描器失效`).toContain(f)
    }
    expect(electron.tables.filter((t) => t.shape === 'object').length, '一个 { zh: {…}, en: {…} } 表都没解析出来').toBeGreaterThanOrEqual(2)
    expect(Object.keys(electron.fragments).length, 'defineMainMessages 片段一条都没取出来').toBeGreaterThanOrEqual(14)
    expect(electron.logs.length, '一处中文日志都没归到 log 类 —— 分类器坏了').toBeGreaterThan(50)
  })

  it('M1. main.* 命名空间双向保留:渲染层字典不许有 main.*,主进程片段只许 main.*;片段可静态取值、不互相覆盖', () => {
    const rendererMain = Object.keys(rendererZh).concat(Object.keys(rendererEn)).filter((k) => k.startsWith('main.'))
    expect([...new Set(rendererMain)].sort(), '渲染层字典里出现了 main.* 键(那是主进程的命名空间)').toEqual([])
    const notMain = Object.entries(electron.fragments).filter(([k]) => !k.startsWith('main.')).map(([k, v]) => `${k}  <- ${v.file}:${v.line}`)
    expect(notMain, 'defineMainMessages 片段的键必须以 main.<模块>. 开头').toEqual([])
    expect(electron.fragmentProblems, 'defineMainMessages 片段有问题').toEqual([])
  })

  it('M2. 主进程 mt(\'k\') / mtFor(l, \'k\') 用到的字面量键都在主进程片段里(主进程看不到渲染层字典)', () => {
    const unknown = electron.mtKeys.filter((m) => !(m.key in electron.fragments)).map((m) => `${m.key}  <- ${m.file}:${m.line}`)
    expect(electron.mtKeys.length, '一处 mt(\'…\') 都没扫到').toBeGreaterThan(0)
    expect(unknown, `主进程片段里没有这些键,界面会直接显示键名:\n  ${unknown.join('\n  ')}`).toEqual([])
  })

  it('M3. 原生界面出口(对话框 / 通知 / 托盘 / 菜单 / 窗口标题)里没有硬编码中文', () => {
    const report = electron.sinks.map((h) => `${h.file}:${h.line}  ${h.text}`)
    expect(report, `这些原生界面文案只有中文,英文系统下照样弹中文 —— 改成 mt('main.<模块>.…') 并在 defineMainMessages 片段里补 zh/en:\n  ${report.join('\n  ')}`).toEqual([])
  })

  it('M4. 主进程的 { zh, en } 双语表键集一致、en 不含汉字', () => {
    const bad: string[] = []
    for (const t of electron.tables) {
      if (t.onlyZh.length) bad.push(`${t.file}:${t.line} 只有 zh 的键:${t.onlyZh.join(', ')}`)
      if (t.onlyEn.length) bad.push(`${t.file}:${t.line} 只有 en 的键:${t.onlyEn.join(', ')}`)
      for (const e of t.enHan) bad.push(`${t.file}:${t.line} en 仍含中文:${e}`)
    }
    expect(bad, `双语表没对齐:\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('M5. 其余汉字字面量按文件计数,台账只许减少(新增的改原因码或 mt())', () => {
    const found = Object.fromEntries(Object.entries(electron.debt).map(([f, hits]) => [f, hits.length]))
    const unregistered = Object.entries(electron.debt).filter(([f]) => !ELECTRON_HAN_DEBT[f])
      .map(([f, hits]) => `${f}(${hits.length} 处)\n      ${hits.slice(0, 5).map((h) => `${h.line}  ${h.text}`).join('\n      ')}`)
    const miscount = Object.entries(ELECTRON_HAN_DEBT).filter(([f, [n]]) => (found[f] ?? 0) !== n)
      .map(([f, [n]]) => `${f}  台账 ${n},源码 ${found[f] ?? 0}${(found[f] ?? 0) > n ? '  ← 多出来的改成原因码或 mt(),别加数' : '  ← 减少了:把台账的数改小(删到 0 就删掉这一行)'}`)
    expect(unregistered, `这些文件新出现了硬编码中文(不是日志 / 双语表 / 原生出口):改成原因码或 mt(),不要登记进台账:\n  ${unregistered.join('\n  ')}`).toEqual([])
    expect(miscount, `欠账台账与源码对不上:\n  ${miscount.join('\n  ')}`).toEqual([])
  })
})
