/**
 * Soft 随包内置后,磁盘旧副本的迁移(themeMigrations.ts)。全部在临时目录里跑,夹具是历代种子的原样写盘内容
 * (electron/fixtures/soft-seeds),绝不碰真实的数据目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SHIPPED_SOFT_SEEDS, SOFT_MIGRATION_MARKER, customManifest, fingerprint, isShippedSoft, migrateDiskSoft,
} from './themeMigrations'
import { readThemesDir } from './themes'

const FIX = join(__dirname, 'fixtures', 'soft-seeds')
const SEEDS = ['2026-06-29', '2026-08-25', '2026-09-23'] as const

let themes: string
let log: ReturnType<typeof vi.fn>
const run = () => migrateDiskSoft(themes, { log, now: () => new Date('2026-11-08T12:00:00.000Z') })

beforeEach(async () => {
  themes = join(await mkdtemp(join(tmpdir(), 'forsion-soft-migrate-')), 'themes')
  await mkdir(themes)
  log = vi.fn()
})
afterEach(async () => {
  await chmod(join(themes, 'soft', 'theme.json'), 0o644).catch(() => {})
  await rm(join(themes, '..'), { recursive: true, force: true })
})

/** 整棵目录的快照:相对路径 → 字节(十六进制)。迁移前后比对 = 「一个字节都没动」。 */
async function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await snapshot(p, base, out)
    else out[p.slice(base.length + 1)] = e.isSymbolicLink() ? 'symlink' : (await readFile(p)).toString('hex')
  }
  return out
}

const seed = async (version: (typeof SEEDS)[number], folder = 'soft'): Promise<void> => {
  await cp(join(FIX, version), join(themes, folder), { recursive: true })
}
const fixture = (version: (typeof SEEDS)[number], file: 'theme.json' | 'theme.css') => readFile(join(FIX, version, file), 'utf8')

describe('SHIPPED_SOFT_SEEDS', () => {
  it('每个夹具都对得上一条指纹(夹具与指纹表同源,改一边另一边会红)', async () => {
    for (const v of SEEDS) {
      const json = fingerprint(await fixture(v, 'theme.json')), css = fingerprint(await fixture(v, 'theme.css'))
      expect(SHIPPED_SOFT_SEEDS.some((s) => s.json === json && s.css === css), v).toBe(true)
    }
    expect(SHIPPED_SOFT_SEEDS).toHaveLength(SEEDS.length)
  })

  it('json 与 css 要是同一版才算原样(06-29 的 json 配 09-23 的 css 不算)', async () => {
    expect(isShippedSoft(await fixture('2026-06-29', 'theme.json'), await fixture('2026-09-23', 'theme.css'))).toBe(false)
  })
})

describe('migrateDiskSoft —— 没改过:原地让位,一个字节都不动', () => {
  it.each(SEEDS)('%s 的种子原样', async (v) => {
    await seed(v)
    const before = await snapshot(themes)
    expect(await run()).toEqual({ action: 'none', reason: 'unmodified' })
    expect(await snapshot(themes)).toEqual(before)
    expect(log).not.toHaveBeenCalled()
  })

  it('CRLF 换行的副本(Windows 上被编辑器 / git 转过)仍算原样', async () => {
    await mkdir(join(themes, 'soft'))
    for (const f of ['theme.json', 'theme.css'] as const) {
      await writeFile(join(themes, 'soft', f), (await fixture('2026-06-29', f)).replace(/\n/g, '\r\n'))
    }
    const before = await snapshot(themes)
    expect(await run()).toEqual({ action: 'none', reason: 'unmodified' })
    expect(await snapshot(themes)).toEqual(before)
  })

  it('没有 soft/ → 什么都不做', async () => {
    expect(await run()).toEqual({ action: 'none', reason: 'absent' })
    expect(await snapshot(themes)).toEqual({})
  })
})

describe('migrateDiskSoft —— 改过:整目录另存成 soft-custom', () => {
  it('theme.css 逐字节不变、theme.json 只换身份、附带文件一起走、写标记和一行日志', async () => {
    await seed('2026-06-29')
    const css = (await fixture('2026-06-29', 'theme.css')).replace('--radius-lg: 18px;', '--radius-lg: 24px;')
    await writeFile(join(themes, 'soft', 'theme.css'), css)
    await writeFile(join(themes, 'soft', 'notes.txt'), 'mine')
    const original = JSON.parse(await fixture('2026-06-29', 'theme.json'))

    expect(await run()).toEqual({ action: 'kept-custom', from: 'soft', to: 'soft-custom' })

    await expect(lstat(join(themes, 'soft'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(themes, 'soft-custom', 'theme.css'))).toEqual(Buffer.from(css, 'utf8'))
    expect(await readFile(join(themes, 'soft-custom', 'notes.txt'), 'utf8')).toBe('mine')
    const m = JSON.parse(await readFile(join(themes, 'soft-custom', 'theme.json'), 'utf8'))
    expect(m.id).toBe('soft') // CSS 写给 [data-theme='soft'],读盘时映射到目录名
    expect(m.name).toBe('Soft(自改)')
    expect(m.nameEn).toBe('Soft (custom)')
    expect(m.preview.title).toBeUndefined() // 种子的「Soft」标题去掉,卡片才显示「Soft(自改)」
    const { id: _a, name: _b, nameEn: _c, preview: p1, ...rest1 } = m
    const { id: _d, name: _e, nameEn: _f, preview: p0, ...rest0 } = original
    expect(rest1).toEqual(rest0) // 其余字段原样
    const { title: _t, ...pv0 } = p0
    expect(p1).toEqual(pv0)
    expect(JSON.parse(await readFile(join(themes, SOFT_MIGRATION_MARKER), 'utf8')))
      .toEqual({ from: 'soft', to: 'soft-custom', at: '2026-11-08T12:00:00.000Z', css: fingerprint(css) })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('只改了 theme.json 也算改过', async () => {
    await seed('2026-09-23')
    const j = JSON.parse(await fixture('2026-09-23', 'theme.json'))
    await writeFile(join(themes, 'soft', 'theme.json'), JSON.stringify({ ...j, description: 'mine' }, null, 2) + '\n')
    expect((await run()).action).toBe('kept-custom')
    expect(JSON.parse(await readFile(join(themes, 'soft-custom', 'theme.json'), 'utf8')).description).toBe('mine')
    expect(await readFile(join(themes, 'soft-custom', 'theme.css'), 'utf8')).toBe(await fixture('2026-09-23', 'theme.css'))
  })

  it('用户自己改了预览标题就留着', () => {
    const out = customManifest({ id: 'soft', name: 'x', preview: { title: { text: 'Pastel' }, accent: '#000' } })
    expect((out.preview as { title: { text: string } }).title.text).toBe('Pastel')
    expect(customManifest({ name: 'x' }).id).toBe('soft') // 没写 id 的也补成 soft(这份 CSS 原本就住在 soft/ 里)
  })

  it('迁移后列主题:soft-custom 的 CSS 映射到自己、带 migratedFrom;磁盘 CSS 不变', async () => {
    await seed('2026-06-29')
    const css = (await fixture('2026-06-29', 'theme.css')) + '\n/* mine */\n'
    await writeFile(join(themes, 'soft', 'theme.css'), css)
    await run()
    const [t] = await readThemesDir(themes)
    expect(t.id).toBe('soft-custom')
    expect(t.migratedFrom).toBe('soft')
    expect(t.manifest.nameEn).toBe('Soft (custom)')
    expect(t.css).not.toContain(`[data-theme='soft']`)
    expect(t.css).toContain(`[data-theme="soft-custom"] .rb`)
    expect(await readFile(join(themes, 'soft-custom', 'theme.css'), 'utf8')).toBe(css)
  })

  it('第二次跑什么都不做(soft/ 已不在)', async () => {
    await seed('2026-08-25')
    await writeFile(join(themes, 'soft', 'theme.css'), 'x{}')
    await run()
    const after = await snapshot(themes)
    log.mockClear()
    expect(await run()).toEqual({ action: 'none', reason: 'absent' })
    expect(await snapshot(themes)).toEqual(after)
    expect(log).not.toHaveBeenCalled()
  })

  it('上次只做完第一步(theme.json 已改名、还没改目录)就崩了 → 这次续上,CSS 照样原样', async () => {
    await seed('2026-06-29')
    await writeFile(join(themes, 'soft', 'theme.css'), 'mine{}')
    const half = customManifest(JSON.parse(await fixture('2026-06-29', 'theme.json')))
    await writeFile(join(themes, 'soft', 'theme.json'), JSON.stringify(half, null, 2) + '\n')
    expect((await run()).action).toBe('kept-custom')
    expect(await readFile(join(themes, 'soft-custom', 'theme.css'), 'utf8')).toBe('mine{}')
    expect(JSON.parse(await readFile(join(themes, 'soft-custom', 'theme.json'), 'utf8'))).toEqual(half)
  })
})

describe('migrateDiskSoft —— 不知道 / 已经有 soft-custom:什么都不动', () => {
  const untouched = async (expected: string) => {
    const before = await snapshot(themes)
    expect(await run()).toEqual({ action: 'none', reason: expected })
    expect(await snapshot(themes)).toEqual(before)
    expect(log).not.toHaveBeenCalled()
  }

  it('theme.json 是坏 JSON', async () => {
    await seed('2026-06-29')
    await writeFile(join(themes, 'soft', 'theme.json'), '{ "id": "soft", ')
    await untouched('unknown')
  })

  it('theme.json 是合法 JSON 但不是对象', async () => {
    await seed('2026-06-29')
    await writeFile(join(themes, 'soft', 'theme.json'), '[]')
    await untouched('unknown')
  })

  it('少了 theme.json 或 theme.css', async () => {
    await seed('2026-06-29')
    await rm(join(themes, 'soft', 'theme.css'))
    await untouched('unknown')
    await rm(join(themes, 'soft'), { recursive: true })
    await seed('2026-06-29')
    await rm(join(themes, 'soft', 'theme.json'))
    await untouched('unknown')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('theme.json 读不了(权限)', async () => {
    await seed('2026-06-29')
    await writeFile(join(themes, 'soft', 'theme.css'), 'mine{}')
    await chmod(join(themes, 'soft', 'theme.json'), 0o000)
    expect(await run()).toEqual({ action: 'none', reason: 'unknown' })
    await chmod(join(themes, 'soft', 'theme.json'), 0o644)
    expect(await readFile(join(themes, 'soft', 'theme.css'), 'utf8')).toBe('mine{}')
    await expect(lstat(join(themes, 'soft-custom'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('soft 是文件 / 符号链接,不是种子写出来的目录', async () => {
    await writeFile(join(themes, 'soft'), 'not a folder')
    await untouched('unknown')
    await rm(join(themes, 'soft'))
    await seed('2026-06-29', 'elsewhere')
    await writeFile(join(themes, 'elsewhere', 'theme.css'), 'mine{}')
    await symlink(join(themes, 'elsewhere'), join(themes, 'soft'))
    await untouched('unknown')
  })

  it('soft-custom 已经在(用户自己的),绝不覆盖,soft/ 也不动', async () => {
    await seed('2026-06-29')
    await writeFile(join(themes, 'soft', 'theme.css'), 'mine{}')
    await mkdir(join(themes, 'soft-custom'))
    await writeFile(join(themes, 'soft-custom', 'theme.css'), 'theirs{}')
    await writeFile(join(themes, 'soft-custom', 'theme.json'), '{"name":"theirs"}')
    await untouched('custom-exists')
  })

  it('空的 soft-custom 目录也算已经在(rename 会把空目录顶掉,不能让它发生)', async () => {
    await seed('2026-06-29')
    await writeFile(join(themes, 'soft', 'theme.css'), 'mine{}')
    await mkdir(join(themes, 'soft-custom'))
    const before = await snapshot(themes)
    expect(await run()).toEqual({ action: 'none', reason: 'custom-exists' })
    expect(await snapshot(themes)).toEqual(before)
    expect((await readdir(join(themes, 'soft-custom'))).length).toBe(0)
  })
})
