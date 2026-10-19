// tangu/messages.ts 是 Tangu 自己的文案片段(核心插件化 2c):只有 import 了它的模块被求值,这些键才进字典。
// 钉住一条:源码里用字面量写到这些键的文件,必须**自己** import 这个片段 —— 靠别处碰巧先加载过,换个窗口 / 入口就会原样露出键名。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')
const GENESIS = resolve(SRC, '../../..')
const FRAGMENT = join(__dirname, 'messages.ts')
const ROOTS = ['desktop/frontend/src', 'mobile/src', 'web/src', 'lcl'].map((r) => join(GENESIS, r))
const KEYS = [...readFileSync(FRAGMENT, 'utf8').matchAll(/^ {2}'([^']+)': \{ zh:/gm)].map((m) => m[1])

function* sources(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* sources(p)
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.(test|spec)\./.test(name)) yield p
  }
}

const importsFragment = (file: string, src: string): boolean =>
  [...src.matchAll(/import\s*['"]([^'"]+)['"]/g)].some((m) => m[1].startsWith('.') && resolve(dirname(file), m[1]).replace(/\.ts$/, '') === FRAGMENT.replace(/\.ts$/, ''))

describe('tangu/messages 片段', () => {
  it('仪器自检:片段里的键解析得出来', () => {
    expect(KEYS.length).toBeGreaterThan(300)
  })

  it('用到片段里的键的文件都自己 import 了它', () => {
    const keys = new Set(KEYS)
    const bad: string[] = []
    for (const root of ROOTS) for (const file of sources(root)) {
      if (file === FRAGMENT) continue
      const src = readFileSync(file, 'utf8')
      const used = [...src.matchAll(/(['"`])([\w.-]+)\1/g)].map((m) => m[2]).filter((k) => keys.has(k))
      if (used.length && !importsFragment(file, src)) bad.push(`${relative(GENESIS, file)}(${used[0]})`)
    }
    // 红了:Tangu 文件就在 import 区末尾补 `import '…/tangu/messages'`;宿主文件别用 Tangu 的键,把键挪回宿主字典 i18n.tsx
    expect(bad).toEqual([])
  })
})
