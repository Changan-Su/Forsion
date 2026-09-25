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
//
// 新增文案时这个文件红了,不要来这里加豁免 —— 去把 en 词条补上,那才是它存在的意义。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import './i18n.generated' // 必须先注册,否则只看到 i18n.tsx 里的基础键
import { __dictSnapshot } from './i18n'
// LCL 引擎自带的文案表(宿主装配期 registerMessages 进来;见 lcl/engine/i18nSeam.ts)。纯字面量,直接 import。
import { LCL_MESSAGES } from '../../../lcl/engine/engineMessages'

const HAN = /[一-龥]/
const SRC = __dirname
/** 引擎源码:以前只扫 desktop,lcl 里的 t('…') / engineTr('…') 缺键没人管(U-45)。 */
const LCL_ENGINE = join(__dirname, '../../../lcl/engine')

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
const frag = collectFragments(ALL_SRC.filter((f) => readFileSync(f, 'utf8').includes('registerMessages(')))
const lclZh = Object.fromEntries(Object.entries(LCL_MESSAGES).map(([k, v]) => [k, v.zh]))
const lclEn = Object.fromEntries(Object.entries(LCL_MESSAGES).map(([k, v]) => [k, v.en]))
const zh = { ...base.zh, ...frag.zh, ...lclZh }
const en = { ...base.en, ...frag.en, ...lclEn }

/** 值里带汉字却**故意**如此的键:产品名/品牌/中文专有名词在英文界面下也该保持原样。 */
const EN_MAY_CONTAIN_HAN = new Set<string>([
  'locale.zh', // 语言切换器里的语言名:英文界面下也该写「中文」,不是漏翻
])

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
    for (const file of [...ALL_SRC, ...ENGINE_SRC]) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(USE)) {
        const key = m[2]
        // 只认带点的命名空间键;`t('x')` 这种单词多半是别的同名函数(误报源)。
        if (!key.includes('.')) continue
        if (key in zh || key in en) continue
        const list = unknown.get(key) ?? []
        list.push(relative(SRC, file))
        unknown.set(key, list)
      }
    }
    const report = [...unknown.entries()].map(([k, files]) => `${k}  <- ${[...new Set(files)].join(', ')}`).sort()
    expect(report, `字典里没有这些键,界面会直接渲染键名:\n  ${report.join('\n  ')}`).toEqual([])
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
    const TERMS = new Set([
      'Agent', 'Space', 'MCP', 'Hooks', 'Git', 'AI', 'Python', 'Vault', 'Sandbox', 'Provider', 'ID', 'URL', 'HTTP', 'SSE', 'DEV', 'P2P',
      'Forsion', 'Tangu', 'Muse', 'Amadeus', 'Note', 'Chat', 'Work', 'Desk', 'QQ', 'Telegram', 'OpenAI', 'Codex', 'OpenCode', 'Claude', 'Code',
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

  it('E. zh 标点(报告模式,U-32):半角 , ; : ( ) ? ! 紧挨汉字的计数与样例,不让测试变红', () => {
    // 规则见 genesis-ui skill「中文标点」:句内全角;{var}、反引号代码、URL、路径、快捷键、HH:mm 除外。
    // 全仓 codemod 另立项(要排除落盘 / 按值识别的键,先 grep 按中文文案选元素的台架)。清零后把这里改成硬断言。
    const strip = (v: string): string => v
      .replace(/\{\w+\}/g, '□')
      .replace(/`[^`]*`/g, '□')
      .replace(/https?:\/\/\S+/g, '□')
      .replace(/(?:~|\.{1,2})?\/[\w./*~-]+/g, '□')
      .replace(/(?:⌘|Ctrl|Cmd|Shift|Alt|Option|Meta)[+\w⇧⌥⌘,.]*/g, '□')
      .replace(/\d{1,2}:\d{2}/g, '□')
    const PUNCT = /[一-龥][,;:()?!]|[,;:()?!][一-龥]/g
    let hits = 0
    const keys: string[] = []
    for (const [k, v] of Object.entries(zh)) {
      const n = (strip(v).match(PUNCT) ?? []).length
      if (n) { hits += n; keys.push(`${k} = ${v.slice(0, 60)}`) }
    }
    console.info(`[i18n E] zh 半角标点紧挨汉字:${hits} 处 / ${keys.length} 个键(总 ${Object.keys(zh).length})。样例:\n  ${keys.slice(0, 8).join('\n  ')}`)
    // 防假绿:扫描确实跑过(字典非空);已手修的高曝光几条不许回退。
    expect(Object.keys(zh).length).toBeGreaterThan(1000)
    for (const k of ['input.placeholder', 'chat.emptyTitle', 'chat.emptyHint', 'settings.workspace.hint', 'onboarding.workspace.hint', 'input.tip.steer', 'sidebar.mode.tip']) {
      expect(strip(zh[k]).match(PUNCT), `${k} 已手修成全角,别改回半角:${zh[k]}`).toBeNull()
    }
  })

  it('H. 日期 / 时间显示只走 format/time.ts 单源(U-29:不许再跟系统区域走)', () => {
    // 硬断言覆盖两类可静态判定的写法:toLocaleDateString / toLocaleTimeString,以及 new Intl.DateTimeFormat /
    // new Intl.RelativeTimeFormat。裸 `.toLocaleString()` 数字也在用(千分位),静态分不清,所以只拦
    // `new Date(…).toLocaleString(` 这一种明确是日期的形状;其余靠 code review。
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
})
