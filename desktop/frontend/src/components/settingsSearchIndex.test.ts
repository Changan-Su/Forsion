import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../i18n.generated'
import { __dictSnapshot } from '../i18n'
import { SETTINGS_SEARCH_INDEX, matchesSettingsQuery } from './settingsSearchIndex'

// U-15 静态半边:索引项的锚点在源码里真有、子页 key 真存在、标签双语都有。
// 真落点(本端门控下点结果 → 锚点可见)由 check:settingsmode 在真 Electron 里逐项点。
const SRC = readFileSync(join(__dirname, 'SettingsModal.tsx'), 'utf8')

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

  it('按标签或别名匹配,不分大小写', () => {
    const mirror = SETTINGS_SEARCH_INDEX.find((e) => e.id === 'mirror')!
    expect(matchesSettingsQuery(mirror, '国内镜像', '镜像')).toBe(true)
    expect(matchesSettingsQuery(mirror, 'Mirror', 'MIRROR')).toBe(true)
    expect(matchesSettingsQuery(mirror, '国内镜像', '   ')).toBe(false)
    expect(matchesSettingsQuery(mirror, '国内镜像', '字体')).toBe(false)
  })
})
