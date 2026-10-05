import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../i18n.generated'
import './remoteSessionsCopy' // P1-K4:远程会话页的标签是模块级 registerMessages 片段
import './remoteSafetyCopy' // P1-K2:急停与远程锁定区块(经 K4 扩展槽挂在远程会话页末尾)
import './startupAppearanceCopy' // 开屏与图标:片段由 StartupAppearanceSettings 自己 import,登记表不带
import { __dictSnapshot } from '../i18n'
import { SETTINGS_SEARCH_INDEX, matchesSettingsQuery } from './settingsSearchIndex'

// U-15 静态半边:索引项的锚点在源码里真有、子页 key 真存在、标签双语都有。
// 真落点(本端门控下点结果 → 锚点可见)由 check:settingsmode 在真 Electron 里逐项点。
// 锚点可以落在 SettingsModal 直接渲染的独立页组件里(P1-K4 远程会话页的三块面板)。
const SRC = ['SettingsModal.tsx', 'RemoteSessionsSettings.tsx', 'RemoteSafetyPanel.tsx', 'StartupAppearanceSettings.tsx'].map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n')

describe('settings search index', () => {
  it('id 唯一,每项都有检索别名', () => {
    const ids = SETTINGS_SEARCH_INDEX.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of SETTINGS_SEARCH_INDEX) expect(e.keywords.trim().length, e.id).toBeGreaterThan(0)
  })

  it('每个 anchor 都作为 data-setting-anchor / anchor= 字面量出现在 SettingsModal', () => {
    for (const e of SETTINGS_SEARCH_INDEX.filter((x) => x.anchor)) {
      const literal = SRC.includes(`data-setting-anchor="${e.anchor}"`) || SRC.includes(`anchor="${e.anchor}"`)
      expect(literal, `${e.id} → ${e.anchor}`).toBe(true)
    }
  })

  it('每个 sub 都是 subItemsByTab 里真实存在的子页 key', () => {
    for (const e of SETTINGS_SEARCH_INDEX.filter((x) => x.sub)) {
      // fx:<pluginId>:<viewId> = 首方内置包运行期注册的自绘子页(「Forsion 云端」),源码里没有字面量,只核格式
      if (e.sub!.startsWith('fx:')) { expect(e.sub, e.id).toMatch(/^fx:[a-z0-9-]+:[a-z0-9-]+$/); continue }
      expect(SRC.includes(`['${e.sub}',`), `${e.id} → ${e.sub}`).toBe(true)
    }
  })

  it('标签 key 中英都有', () => {
    const { zh, en } = __dictSnapshot()
    for (const e of SETTINGS_SEARCH_INDEX) {
      // settingsmodal.* / modelsettings.* 是 SettingsModal 模块级 registerMessages 片段(只在 import 那个大组件后进字典),按源码核;
      // 片段的 zh/en 成对由 i18nCoverage.test.ts 统一钉。
      if (e.labelKey.startsWith('settingsmodal.') || e.labelKey.startsWith('modelsettings.')) {
        expect(SRC.includes(`'${e.labelKey}': {`), e.labelKey).toBe(true)
        continue
      }
      expect(zh[e.labelKey], `${e.labelKey} zh`).toBeTruthy()
      expect(en[e.labelKey], `${e.labelKey} en`).toBeTruthy()
    }
  })

  // check:settingsmode 在纯 Node 里 `require('sucrase/register/ts')` 后直接 require 这份登记表;那个钩子只认 .ts,
  // 表一旦(连带)import 了 .tsx / 浏览器运行时(i18n.tsx 就是),台架一启动就崩 —— 而 check:* 不在 CI 里,坏了没人知道。
  // 这里按台架同样的方式加载一次(别换成 lib/load-ts.cjs:那是 esbuild 打包,.tsx 照样解析,会假绿)。
  it('纯 Node + sucrase 能直接加载这份表(check:settingsmode 的加载方式)', () => {
    const out = execFileSync(process.execPath, ['-e',
      "require('sucrase/register/ts'); process.stdout.write(String(require(process.argv[1]).SETTINGS_SEARCH_INDEX.length))",
      join(__dirname, 'settingsSearchIndex.ts')], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(Number(out)).toBe(SETTINGS_SEARCH_INDEX.length)
  })

  it('按标签或别名匹配,不分大小写', () => {
    const mirror = SETTINGS_SEARCH_INDEX.find((e) => e.id === 'mirror')!
    expect(matchesSettingsQuery(mirror, '国内镜像', '镜像')).toBe(true)
    expect(matchesSettingsQuery(mirror, 'Mirror', 'MIRROR')).toBe(true)
    expect(matchesSettingsQuery(mirror, '国内镜像', '   ')).toBe(false)
    expect(matchesSettingsQuery(mirror, '国内镜像', '字体')).toBe(false)
  })
})
