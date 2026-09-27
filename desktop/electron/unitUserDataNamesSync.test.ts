/**
 * 桌面 userData 目录名表两份拷贝必须一致(P0 第三轮引擎 openIssue #8):
 *   · desktop/electron/unitHostScope.ts 的 USERDATA_SIBLINGS —— 设备页 /unit/host* 的受保护目录;
 *   · tangu-agent/src/sandbox/hostSandboxProtection.ts 的 USERDATA_NAMES —— 引擎 C4 凭据读清单(兄弟 userData 整片)。
 * 两边各自独立推算(引擎 standalone / CLI 形态也要生效,不能靠桌面传参),加一个品牌名 / 历史名只改一边 = 另一边静默漏掉
 * 那个 userData 里的 tangu-desktop-config.json(unitHostSecret)、remotesync(.dev).json、Local Storage。
 * 按源码文本比(引擎模块不导出这张表,也不该为了测试引进 electron 侧)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildUnitScopeGuard } from './unitHostScope'

const ENGINE_SRC = join(__dirname, '..', '..', 'tangu-agent', 'src', 'sandbox', 'hostSandboxProtection.ts')
const DESKTOP_SRC = join(__dirname, 'unitHostScope.ts')

/** 取 `const NAME = [ ... ]` 里的字符串字面量(单 / 双引号)。取不到就抛 —— 改了声明形态得同步改这里,不能静默比两个空表。 */
function stringArray(file: string, name: string): string[] {
  const src = readFileSync(file, 'utf8')
  const m = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(src)
  if (!m) throw new Error(`${name} not found in ${file}`)
  const items = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2])
  if (!items.length) throw new Error(`${name} in ${file} has no string entries`)
  return items
}

describe('userData 目录名表:桌面与引擎同一张', () => {
  it('USERDATA_SIBLINGS(桌面)== USERDATA_NAMES(引擎),顺序无关', () => {
    const desktop = stringArray(DESKTOP_SRC, 'USERDATA_SIBLINGS')
    const engine = stringArray(ENGINE_SRC, 'USERDATA_NAMES')
    expect([...new Set(engine)].sort()).toEqual([...new Set(desktop)].sort())
  })

  it('两边展开口径一致:每个名字连同 `-dev` 变体都进设备页受保护目录(引擎那侧见 tangu-agent test/remoteR3Integration.test.ts I4b)', () => {
    // 源码里的展开式也钉一下:引擎改了展开方式(比如去掉 -dev)这条会红,提醒两边一起改
    expect(readFileSync(ENGINE_SRC, 'utf8')).toMatch(/USERDATA_NAMES\.flatMap\(\(n\) => \[n, `\$\{n\}-dev`\]\)/)
    const appData = '/nonexistent-appdata-r3'
    const guard = buildUnitScopeGuard({ home: '/nonexistent-home-r3', forsionHome: '/nonexistent-home-r3/.forsion', appData, platform: 'linux' })
    for (const n of stringArray(DESKTOP_SRC, 'USERDATA_SIBLINGS')) {
      expect(guard.protectedPaths).toContain(join(appData, n))
      expect(guard.protectedPaths).toContain(join(appData, `${n}-dev`))
    }
  })
})
