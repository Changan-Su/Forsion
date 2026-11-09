import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { isValidThemeId, readThemesDir } from './themes'
import { SOFT_MIGRATION_MARKER, fingerprint } from './themeMigrations'

describe('isValidThemeId', () => {
  it('accepts kebab/lowercase ids', () => {
    expect(isValidThemeId('soft')).toBe(true)
    expect(isValidThemeId('my-theme-2')).toBe(true)
  })
  it('rejects reserved lovable + illegal ids (防 data-theme/元素 id 注入)', () => {
    expect(isValidThemeId('lovable')).toBe(false)
    expect(isValidThemeId('Bad_Name')).toBe(false)
    expect(isValidThemeId('../evil')).toBe(false)
    expect(isValidThemeId('a b')).toBe(false)
    expect(isValidThemeId('')).toBe(false)
  })
})

describe('readThemesDir', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tangu-themes-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const writeTheme = async (id: string, json: string, css = 'x{}'): Promise<void> => {
    const d = join(dir, id)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'theme.json'), json)
    await writeFile(join(d, 'theme.css'), css)
  }

  it('returns valid themes and forces manifest.id to the folder name', async () => {
    await writeTheme('good', JSON.stringify({ id: 'whatever', name: 'Good' }), 'body{color:red}')
    const out = await readThemesDir(dir)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('good')
    expect(out[0].manifest.id).toBe('good') // 目录名压过 json 里的 id
    expect(out[0].css).toBe('body{color:red}')
  })

  it('skips bad JSON, illegal ids, and the reserved lovable — without throwing', async () => {
    await writeTheme('good', JSON.stringify({ name: 'Good' }))
    await writeTheme('broken', '{ not json')                        // 坏 json
    await writeTheme('lovable', JSON.stringify({ name: 'Hijack' })) // 保留字
    await writeTheme('Bad_Name', JSON.stringify({ name: 'Nope' }))  // 非法 id
    const out = await readThemesDir(dir)
    expect(out.map((t) => t.id)).toEqual(['good'])
  })

  it('skips a theme missing theme.css', async () => {
    await mkdir(join(dir, 'nocss'), { recursive: true })
    await writeFile(join(dir, 'nocss', 'theme.json'), JSON.stringify({ name: 'NoCss' }))
    expect(await readThemesDir(dir)).toHaveLength(0)
  })

  it('returns empty for a missing directory (no throw)', async () => {
    expect(await readThemesDir(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('maps [data-theme=<json id>] to the folder when the CSS never names its folder (migrated soft-custom)', async () => {
    const css = `[data-theme='soft'] { --radius-lg: 22px; }\n.dark[data-theme="soft"] .rb { width: 48px; }\n[data-theme=soft] .sb{}\n[ data-theme = 'soft' ] .x{}\n[data-theme='soft-ish'] .y{}`
    await writeTheme('soft-custom', JSON.stringify({ id: 'soft', name: 'Soft(自改)' }), css)
    const [t] = await readThemesDir(dir)
    expect(t.id).toBe('soft-custom')
    expect(t.css).not.toMatch(/data-theme\s*=\s*['"]?soft['"]?\s*\]/)
    expect(t.css.match(/\[data-theme="soft-custom"\]/g)).toHaveLength(4) // 方括号里带空格的写法也算
    expect(t.css).toContain(`[data-theme='soft-ish'] .y{}`) // 别的 id 不误伤
    // 只改返回给渲染层的文本:磁盘上的 theme.css 一个字节不动
    expect(await readFile(join(dir, 'soft-custom', 'theme.css'), 'utf8')).toBe(css)
  })

  it('leaves CSS alone when the json id equals the folder, or when the CSS already targets its folder', async () => {
    await writeTheme('soft', JSON.stringify({ id: 'soft' }), `[data-theme='soft'] a{}`)
    await writeTheme('my-soft', JSON.stringify({ id: 'soft' }), `[data-theme='my-soft'] a{} [data-theme='soft'] b{}`)
    await writeTheme('noid', JSON.stringify({ name: 'x' }), `[data-theme='soft'] a{}`)
    const out = Object.fromEntries((await readThemesDir(dir)).map((t) => [t.id, t.css]))
    expect(out.soft).toBe(`[data-theme='soft'] a{}`)
    expect(out['my-soft']).toBe(`[data-theme='my-soft'] a{} [data-theme='soft'] b{}`)
    expect(out.noid).toBe(`[data-theme='soft'] a{}`)
  })

  it('still rescopes market themes unconditionally', async () => {
    const folder = 'market-0123abcd-0123-4567-89ab-0123456789ab'
    await writeTheme(folder, JSON.stringify({ id: 'pastel' }), `[data-theme='pastel'] a{}`)
    const [t] = await readThemesDir(dir)
    expect(t.css).toBe(`[data-theme="${folder}"] a{}`)
  })

  it('tags the migrated theme with migratedFrom only when the marker names it and its CSS is the one that was moved', async () => {
    await writeTheme('soft-custom', JSON.stringify({ id: 'soft' }), 'moved{}')
    await writeTheme('other', JSON.stringify({ id: 'other' }))
    expect((await readThemesDir(dir)).every((t) => t.migratedFrom === undefined)).toBe(true)
    const marker = { from: 'soft', to: 'soft-custom', at: '2026-11-08T00:00:00.000Z', css: fingerprint('someone else{}') }
    await writeFile(join(dir, SOFT_MIGRATION_MARKER), JSON.stringify(marker)) // 同名目录不是迁移出来的那份
    expect((await readThemesDir(dir)).every((t) => t.migratedFrom === undefined)).toBe(true)
    await writeFile(join(dir, SOFT_MIGRATION_MARKER), JSON.stringify({ ...marker, css: fingerprint('moved{}') }))
    const out = await readThemesDir(dir)
    expect(out.find((t) => t.id === 'soft-custom')!.migratedFrom).toBe('soft')
    expect(out.find((t) => t.id === 'other')!.migratedFrom).toBeUndefined()
    await writeFile(join(dir, SOFT_MIGRATION_MARKER), '{ broken') // 坏标记 = 没有,主题照常列出
    expect((await readThemesDir(dir)).map((t) => [t.id, t.migratedFrom])).toEqual([['other', undefined], ['soft-custom', undefined]])
  })
})

