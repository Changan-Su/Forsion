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

const HAN = /[一-龥]/
const SRC = __dirname

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
const frag = collectFragments(ALL_SRC.filter((f) => readFileSync(f, 'utf8').includes('registerMessages(')))
const zh = { ...base.zh, ...frag.zh }
const en = { ...base.en, ...frag.en }

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
    const USE = /\b(?:t|tr|translate)\(\s*(['"])([\w.-]+)\1/g
    const unknown = new Map<string, string[]>()
    for (const file of ALL_SRC) {
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
})
