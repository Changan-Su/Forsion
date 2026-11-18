/**
 * 设置页规范 v1 的静态半边(2026-11-17,DESIGN「设置页规范」;方案 docs/ToBeImproved/设置规范方案_2026-11-17/)。
 * `npm run check:settings-lint` 单跑;也在 `npm test`(vitest run)里。
 *
 * 新页面一律写 SettingsPage 描述(宿主页面用 `<SettingsPage host>`,插件用 ctx.ui.mountSettingsPage),不手写面板和行。
 * 存量按文件记账(DEBT),**只许减少**:台账和源码对不上就红 —— 多了 = 新写了手写排版,少了 = 迁走了一些,把台账数字改小。
 *
 *  L1 手写面板 / 行:className 里的 settings-panel、settings-control-row(零件实现 SettingsPrimitives / SettingsPage 不算)。
 *  L2 SettingsRow 没给 anchor:设置搜索 / 深链落不到这一行。
 *  L3 两格「开 / 关」分段:二态一律开关(SettingsSwitch / 描述里的 switch)。按 t('…On') + t('…Off') 两颗按钮认。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const SKIP_FILES = new Set(['components/SettingsPrimitives.tsx', 'components/SettingsPage.tsx'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== '__fixtures__') walk(p, out) }
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p)
  }
  return out
}
const FILES = walk(ROOT).map((p) => ({ rel: relative(ROOT, p).split(sep).join('/'), src: readFileSync(p, 'utf8') }))
  .filter((f) => !SKIP_FILES.has(f.rel))

/** className 字符串里的 class 记号(className="…" / className={`…`} / className={'…'})。 */
function classTokens(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) out.push(...(m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/))
  return out
}

/** 一个开标签的属性文本(从 `<Tag` 到对应的 `>` / `/>`,跳过 {…} 与引号里的内容)。 */
function openTags(src: string, tag: string): string[] {
  const out: string[] = []
  let i = 0
  const head = `<${tag}`
  while ((i = src.indexOf(head, i)) >= 0) {
    const nextCh = src[i + head.length]
    if (!/[\s/>]/.test(nextCh ?? '')) { i += head.length; continue }
    let depth = 0, j = i + head.length, quote = ''
    for (; j < src.length; j++) {
      const c = src[j]
      if (quote) { if (c === quote) quote = ''; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(i, j + 1))
    i = j
  }
  return out
}

function count(f: { src: string }) {
  const tokens = classTokens(f.src)
  const handWritten = tokens.filter((t) => t === 'settings-panel' || t === 'settings-control-row').length
  const rowsWithoutAnchor = openTags(f.src, 'SettingsRow').filter((t) => !/\banchor=/.test(t)).length
  let onOffSeg = 0
  for (const m of f.src.matchAll(/<div className="seg"[\s\S]*?<\/div>/g)) {
    const keys = [...m[0].matchAll(/t\('([\w.]+)'\)/g)].map((k) => k[1])
    const buttons = (m[0].match(/<button\b/g) ?? []).length
    if (buttons === 2 && keys.some((k) => /On$/.test(k)) && keys.some((k) => /Off$/.test(k))) onOffSeg++
  }
  return { handWritten, rowsWithoutAnchor, onOffSeg }
}

/** 存量台账:[L1 手写面板 / 行, L2 没锚点的 SettingsRow, L3 开 / 关分段]。只许减少;迁完一页就把它从表里删掉。 */
const DEBT: Record<string, [number, number, number]> = {
  'components/AgentSettingsOverview.tsx': [2, 0, 0],
  'components/BrowserExtensionPanel.tsx': [0, 6, 0],
  'components/ComputerHistorySettings.tsx': [0, 2, 0],
  'components/Connectors.tsx': [5, 4, 0],
  'components/CorePluginUpdates.tsx': [2, 0, 0],
  'components/DecisionGateField.tsx': [0, 1, 0],
  'components/DefaultModelsPage.tsx': [0, 11, 0],
  'components/FileOpenersPanel.tsx': [0, 1, 0],
  'components/GitAccountsSection.tsx': [0, 4, 0],
  'components/GitSettingsSection.tsx': [0, 1, 0],
  'components/LocalProviderImport.tsx': [0, 1, 0],
  'components/MaskingSettingsSection.tsx': [0, 5, 0],
  'components/ModelPickerSettings.tsx': [0, 1, 0],
  'components/MotionThemeSection.tsx': [2, 0, 0],
  'components/NotificationsTab.tsx': [0, 1, 0],
  'components/PluginSettingsForm.tsx': [0, 1, 0],
  'components/RealtimeVoiceSettings.tsx': [0, 2, 0],
  'components/RemoteSafetyPanel.tsx': [0, 3, 0],
  'components/RemoteSessionsSettings.tsx': [0, 4, 0],
  'components/SettingsModal.tsx': [8, 40, 0],
  'components/SpaceAppearancePanel.tsx': [0, 5, 0],
  'components/SpacesTab.tsx': [0, 2, 0],
  'components/StartupAppearanceSettings.tsx': [0, 5, 0],
  'components/VoiceSettingsPage.tsx': [0, 4, 0],
  'components/WebSearchSettings.tsx': [2, 0, 0],
}

describe('设置页规范 v1(静态)', () => {
  const found: Record<string, [number, number, number]> = {}
  for (const f of FILES) {
    const c = count(f)
    if (c.handWritten || c.rowsWithoutAnchor || c.onOffSeg) found[f.rel] = [c.handWritten, c.rowsWithoutAnchor, c.onOffSeg]
  }

  it('仪器自检:认得出手写行、没锚点的行和开 / 关分段', () => {
    const probe = count({ src: `
      <div className="settings-control-row" data-setting-anchor="x"><SettingsRow label="a" control={<i />} /></div>
      <SettingsRow label="b" anchor="b"
        control={<i />} />
      <div className="seg" role="group"><button>{t('settings.theme.glassOn')}</button><button>{t('settings.theme.glassOff')}</button></div>` })
    expect(probe).toEqual({ handWritten: 1, rowsWithoutAnchor: 1, onOffSeg: 1 })
  })

  it('新文件不许手写设置面板 / 行、不许没锚点的 SettingsRow、不许开 / 关分段', () => {
    const fresh = Object.keys(found).filter((f) => !DEBT[f]).map((f) => `${f}  ${JSON.stringify(found[f])}`)
    expect(fresh, `这些文件不在台账里却手写了设置排版:改用 SettingsPage 描述(宿主 <SettingsPage host> / 插件 mountSettingsPage)、给行加 anchor、二态用开关:\n  ${fresh.join('\n  ')}`).toEqual([])
  })

  it('台账只许减少,和源码对得上', () => {
    const off = Object.entries(DEBT).filter(([f, n]) => JSON.stringify(found[f] ?? [0, 0, 0]) !== JSON.stringify(n))
      .map(([f, n]) => `${f}  台账 ${JSON.stringify(n)},源码 ${JSON.stringify(found[f] ?? [0, 0, 0])}`)
    expect(off, `台账与源码对不上(变多 = 新写了手写排版,改成描述;变少 = 迁走了,把台账改小 / 删掉这一行):\n  ${off.join('\n  ')}`).toEqual([])
  })
})
