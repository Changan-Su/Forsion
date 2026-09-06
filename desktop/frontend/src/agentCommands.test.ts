/**
 * 界面面的**跨进程契约**:引擎侧 `set_ui_setting` 的 key enum 必须与渲染端 UI_SETTINGS 逐字一致。
 *
 * 为什么值得钉:两份表分处两个进程、两个 tsconfig、发布节奏还不同(引擎随 worker 镜像走,
 * 渲染端随 tag 走)。漂了不会崩、不会红 —— 只是模型调一个引擎认、渲染端不认的 key,拿到
 * 「unknown setting」然后放弃。这正是 check:parity 当初要防的那类静默失配。
 *
 * ⚠️ 测试住在 desktop 侧而不是 tangu-agent 侧,是因为 **tangu-agent 会被 vendor 进 server**:
 *    住在引擎里的仪器一旦读 ../desktop/** ,vendor 后的副本必然读不到 → CI 恒红。
 *    desktop 不会被 vendor 到任何地方,由它反向读引擎源码是安全的方向。
 *
 * 只读源码文本、不 import:agentCommands.ts 会拖进 themeStore/i18n 等一串浏览器依赖,
 * 而 vitest 这边是 node 环境。契约测试不该为了被测对象去搭半个 DOM。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname
const ENGINE = resolve(HERE, '../../../tangu-agent/src/tools/builtin/uiCommands.ts')
const RENDERER = resolve(HERE, 'agentCommands.ts')

/** 引擎侧:`const SETTING_KEYS = [ … ] as const` 里的字符串。 */
function engineKeys(): string[] {
  const src = readFileSync(ENGINE, 'utf-8')
  const m = src.match(/const SETTING_KEYS = \[([\s\S]*?)\] as const/)
  if (!m) throw new Error('引擎侧 SETTING_KEYS 没抽到 —— 正则脱节了,先修仪器别改断言')
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

/** 渲染端:`export const UI_SETTINGS: Record<string, SettingSpec> = { … }` 的顶层键。 */
function rendererKeys(): string[] {
  const src = readFileSync(RENDERER, 'utf-8')
  const m = src.match(/export const UI_SETTINGS: Record<string, SettingSpec> = \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('渲染端 UI_SETTINGS 没抽到 —— 正则脱节了,先修仪器别改断言')
  return [...m[1].matchAll(/^  ([a-z_]+):/gm)].map((x) => x[1])
}

describe('set_ui_setting 的键在引擎与渲染端之间不许漂', () => {
  it('两侧都抽得到键(抽取失效自检:防重构后正则脱节而静默全绿)', () => {
    expect(engineKeys().length).toBeGreaterThanOrEqual(8)
    expect(rendererKeys().length).toBeGreaterThanOrEqual(8)
  })

  it('键集完全一致', () => {
    expect([...engineKeys()].sort()).toEqual([...rendererKeys()].sort())
  })
})

describe('渲染端设置表的安全纪律', () => {
  const src = readFileSync(RENDERER, 'utf-8')

  it('只允许一处裸写 localStorage(smooth_caret 的具名例外),其余一律走 setter', () => {
    // 纪律仍在:每项设置都有 setter 之外的副作用(applyTheme / applyUiFonts / dispatch 事件),
    // 裸写 = 重启才生效。唯一例外是 setSmoothCaretEnabled —— 它自己只动模块态与 DOM,不落盘,
    // 所以这一项必须由调用方补写。收窄成「只此一处且必须是这个 key」,而不是把规则删掉。
    const hits = [...src.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((m) => m[1].trim())
    expect(hits, '新增裸写要么改走 setter,要么在这里具名放行并写清理由').toEqual(['SMOOTH_CARET_KEY'])
  })

  it('配色两轴不许把 custom 开给 agent —— 它骑的是模型看不见的残留种子色', () => {
    // listSkins() 是含 custom 的(theme/registry.ts:94)。直接 .map(s=>s.id) 就会把它放进去,
    // 模型设过去 = 界面套用一个任意 hex,黑底黑字也是可能结果。回归防线。
    expect(src).toMatch(/filter\(\(id\) => id !== 'custom'\)/)
    expect(src, "accent/background 不许直接用 listSkins().map").not.toMatch(/values: \(\) => listSkins\(\)\.map/)
  })

  it('ui_zoom 的下界收窄到 0.8:setUiZoom 自己只夹到 0.5,而 0.5 是可读性锁死', () => {
    const m = src.match(/const ZOOM_MIN = ([\d.]+)/)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(0.8)
  })
})
