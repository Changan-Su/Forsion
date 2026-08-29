/**
 * Market 安装解压单测:重点是**安全边界**(路径穿越拒绝)+ GitHub source zip 的剥顶层。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { isSafeSlug, isJunkPath, computeStripPrefix, safeEntryPath, extractZipToDir, readInstalledVersion, readUserPluginDirs, detectMarketType, marketItemDir } from './marketInstall'

async function zipOf(names: string[]): Promise<Buffer> {
  const z = new JSZip()
  for (const n of names) z.file(n, '{}')
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer' }))
}

describe('detectMarketType(插件双类型实测纠偏)', () => {
  it('后端标 plugin 但包里是 manifest.json → 纠正为 amadeus-plugin(forsion-mindmap 场景)', async () => {
    expect(await detectMarketType(await zipOf(['manifest.json', 'main.js']), 'plugin')).toBe('amadeus-plugin')
  })
  it('后端标 amadeus-plugin 但包里是 tangu-plugin.json → 纠正为 plugin', async () => {
    expect(await detectMarketType(await zipOf(['tangu-plugin.json', 'dist/index.js']), 'amadeus-plugin')).toBe('plugin')
  })
  it('正确标注不动:引擎包(tangu-plugin.json)保持 plugin', async () => {
    expect(await detectMarketType(await zipOf(['tangu-plugin.json']), 'plugin')).toBe('plugin')
  })
  it('二者皆有/皆无 → 尊重后端 type', async () => {
    expect(await detectMarketType(await zipOf(['tangu-plugin.json', 'manifest.json']), 'plugin')).toBe('plugin')
    expect(await detectMarketType(await zipOf(['readme.md']), 'amadeus-plugin')).toBe('amadeus-plugin')
  })
  it('嵌套目录里的 manifest 也算(单层文件夹包)', async () => {
    expect(await detectMarketType(await zipOf(['my-plugin/manifest.json', 'my-plugin/main.js']), 'plugin')).toBe('amadeus-plugin')
  })
  it('包根 manifest.json + 嵌套 example 的 tangu-plugin.json → 以最浅者(amadeus-plugin)为准', async () => {
    expect(await detectMarketType(await zipOf(['manifest.json', 'examples/engine/tangu-plugin.json', 'main.js']), 'plugin')).toBe('amadeus-plugin')
  })
  it('引擎包根 tangu-plugin.json + 嵌套 example 的 manifest.json → 以最浅者(plugin)为准', async () => {
    expect(await detectMarketType(await zipOf(['tangu-plugin.json', 'examples/ui/manifest.json']), 'amadeus-plugin')).toBe('plugin')
  })
  it('非插件类型原样返回(即便含 manifest.json)', async () => {
    expect(await detectMarketType(await zipOf(['manifest.json']), 'theme')).toBe('theme')
    expect(await detectMarketType(await zipOf(['theme.json']), 'theme')).toBe('theme')
  })
})

describe('isSafeSlug', () => {
  it('接受 kebab', () => { expect(isSafeSlug('my-skill')).toBe(true); expect(isSafeSlug('a1')).toBe(true) })
  it('拒绝穿越/大写/空/斜杠', () => {
    for (const s of ['../x', 'A', '', 'a/b', '.', 'a..b/../c', '-x']) expect(isSafeSlug(s)).toBe(false)
  })
})

describe('isJunkPath', () => {
  it('命中 __MACOSX/.DS_Store/Thumbs.db', () => {
    expect(isJunkPath('__MACOSX/my-skill/._SKILL.md')).toBe(true)
    expect(isJunkPath('my-skill/.DS_Store')).toBe(true)
    expect(isJunkPath('Thumbs.db')).toBe(true)
    expect(isJunkPath('my-skill/SKILL.md')).toBe(false)
  })
})

describe('computeStripPrefix', () => {
  it('单层顶级目录(source zip)无 manifest → 剥该目录', () => {
    expect(computeStripPrefix(['repo-sha/SKILL.md', 'repo-sha/lib/x.js'])).toBe('repo-sha/')
  })
  it('内容在根 / 多个顶级 → 不剥', () => {
    expect(computeStripPrefix(['SKILL.md', 'lib/x.js'])).toBe('')
    expect(computeStripPrefix(['SKILL.md'])).toBe('')
  })
  it('macOS 压缩文件夹(__MACOSX 兄弟目录)→ 按 manifest 重定根到包裹目录', () => {
    expect(
      computeStripPrefix(['my-skill/SKILL.md', '__MACOSX/my-skill/._SKILL.md'], ['SKILL.md']),
    ).toBe('my-skill/')
  })
  it('嵌套多层 → 以最浅 manifest 所在目录为根', () => {
    expect(computeStripPrefix(['parent/my-skill/SKILL.md', 'parent/my-skill/lib/x.js'], ['SKILL.md'])).toBe('parent/my-skill/')
  })
  it('manifest 已在根 → 不剥', () => {
    expect(computeStripPrefix(['SKILL.md', 'lib/x.js'], ['SKILL.md'])).toBe('')
  })
  it('plugin/agent/space manifest 名', () => {
    expect(computeStripPrefix(['pkg/tangu-plugin.json'], ['tangu-plugin.json'])).toBe('pkg/')
    expect(computeStripPrefix(['pkg/config.toml', 'pkg/SOUL.md'], ['config.toml'])).toBe('pkg/')
    expect(computeStripPrefix(['focus/space.json'], ['space.json'])).toBe('focus/')
  })
  it('theme/amadeus-plugin manifest 名', () => {
    expect(computeStripPrefix(['kami/theme.json', 'kami/theme.css'], ['theme.json'])).toBe('kami/')
    expect(computeStripPrefix(['pkg/manifest.json', 'pkg/main.js'], ['manifest.json'])).toBe('pkg/')
  })
})

describe('readInstalledVersion(theme/amadeus-plugin)', () => {
  it('theme 读 theme.json version(去前导 v)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-th-'))
    writeFileSync(join(dir, 'theme.json'), JSON.stringify({ id: 'kami', name: 'Kami', version: 'v1.2.0' }))
    expect(await readInstalledVersion('theme', dir)).toBe('1.2.0')
  })
  it('amadeus-plugin 读 manifest.json version;缺 manifest → null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-ap-'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'hello', version: '0.3.1' }))
    expect(await readInstalledVersion('amadeus-plugin', dir)).toBe('0.3.1')
    expect(await readInstalledVersion('amadeus-plugin', join(dir, 'nope'))).toBeNull()
  })
})

describe('readUserPluginDirs', () => {
  it('manifest id → 目录名映射(id 可 ≠ 目录名);无/坏 manifest、非 kebab id 与点目录跳过;根缺失 → 空', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mk-up-'))
    mkdirSync(join(root, 'my-dir'), { recursive: true })
    writeFileSync(join(root, 'my-dir', 'tangu-plugin.json'), JSON.stringify({ id: 'real-id', version: '1.0.0' }))
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', 'tangu-plugin.json'), '{oops')
    mkdirSync(join(root, 'bad-id'))
    writeFileSync(join(root, 'bad-id', 'tangu-plugin.json'), JSON.stringify({ id: 'MyPlugin' })) // loader 也不会加载它
    mkdirSync(join(root, 'no-manifest'))
    mkdirSync(join(root, '.hidden'))
    expect(await readUserPluginDirs(root)).toEqual([{ id: 'real-id', slug: 'my-dir' }])
    expect(await readUserPluginDirs(join(root, 'missing'))).toEqual([])
  })
})

describe('safeEntryPath', () => {
  it('剥前缀后取相对路径', () => { expect(safeEntryPath('repo/SKILL.md', 'repo/')).toBe('SKILL.md') })
  it('不在前缀下 → null(旁支丢弃)', () => { expect(safeEntryPath('other/x.js', 'repo/')).toBeNull() })
  it('垃圾条目 → null', () => { expect(safeEntryPath('__MACOSX/x', '')).toBeNull() })
  it('穿越路径 → null', () => {
    expect(safeEntryPath('../evil', '')).toBeNull()
    expect(safeEntryPath('repo/../../etc/passwd', 'repo/')).toBeNull()
    expect(safeEntryPath('/abs', '')).toBe('abs') // 前导斜杠被剥成相对,仍安全
  })
})

describe('extractZipToDir', () => {
  it('正常解压 + 剥 GitHub source zip 顶层', async () => {
    const zip = new JSZip()
    zip.file('owner-repo-abc123/SKILL.md', '# hi')
    zip.file('owner-repo-abc123/lib/util.js', 'export const x=1')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const dest = mkdtempSync(join(tmpdir(), 'mk-'))
    const n = await extractZipToDir(buf, dest)
    expect(n).toBe(2)
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('# hi')
    expect(existsSync(join(dest, 'lib/util.js'))).toBe(true)
    expect(existsSync(join(dest, 'owner-repo-abc123'))).toBe(false) // 顶层已剥
  })

  it('macOS 压缩文件夹(__MACOSX 兄弟目录)→ manifest 重定根到 dest 根,不写垃圾/包裹层', async () => {
    const zip = new JSZip()
    zip.file('my-skill/SKILL.md', '# hi')
    zip.file('my-skill/lib/util.js', 'export const x=1')
    zip.file('__MACOSX/my-skill/._SKILL.md', 'junk')
    zip.file('.DS_Store', 'junk')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const dest = mkdtempSync(join(tmpdir(), 'mk-'))
    const n = await extractZipToDir(buf, dest, ['SKILL.md'])
    expect(n).toBe(2)
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('# hi')
    expect(existsSync(join(dest, 'lib/util.js'))).toBe(true)
    expect(existsSync(join(dest, 'my-skill'))).toBe(false) // 包裹层已剥
    expect(existsSync(join(dest, '__MACOSX'))).toBe(false) // 垃圾未写
    expect(existsSync(join(dest, '.DS_Store'))).toBe(false)
  })

  it('space 包(space.json manifest)重定根解压', async () => {
    const zip = new JSZip()
    zip.file('focus/space.json', JSON.stringify({ id: 'focus', name: 'Focus', layout: { main: [{ type: 'chat' }] } }))
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const dest = mkdtempSync(join(tmpdir(), 'mk-'))
    const n = await extractZipToDir(buf, dest, ['space.json'])
    expect(n).toBe(1)
    expect(JSON.parse(readFileSync(join(dest, 'space.json'), 'utf8')).id).toBe('focus')
  })

  // jszip 自身在 generate 时会规整 '../' → 经它造的 zip 到不了 safeEntryPath 的拒绝分支(双重防线)。
  // 这里断言**端到端安全属性**:无论如何,绝不在 dest 之外落盘。safeEntryPath 的纯单测已覆盖拒绝逻辑。
  it('穿越条目不写出 dest 之外', async () => {
    const zip = new JSZip()
    zip.file('SKILL.md', 'ok')
    zip.file('../../evil.sh', 'rm -rf')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const dest = mkdtempSync(join(tmpdir(), 'mk-'))
    await extractZipToDir(buf, dest)
    expect(existsSync(join(dest, '..', 'evil.sh'))).toBe(false)
    expect(existsSync(join(dest, '..', '..', 'evil.sh'))).toBe(false)
  })
})

// ── marketItemDir:卸载的安全面(2026-08-25)──────────────────────────────
describe('marketItemDir', () => {
  const HOME = '/tmp/forsion-home'

  it('六类各自落到自己的安装目录', () => {
    expect(marketItemDir(HOME, 'skill', 'my-skill')).toBe(`${HOME}/tangu/skills/my-skill`)
    expect(marketItemDir(HOME, 'agent', 'my-agent')).toBe(`${HOME}/tangu/agents/my-agent`)
    expect(marketItemDir(HOME, 'plugin', 'my-plugin')).toBe(`${HOME}/tangu/plugins/my-plugin`)
    expect(marketItemDir(HOME, 'space', 'my-space')).toBe(`${HOME}/spaces/my-space`)
    expect(marketItemDir(HOME, 'theme', 'my-theme')).toBe(`${HOME}/themes/my-theme`)
    expect(marketItemDir(HOME, 'amadeus-plugin', 'my-fp')).toBe(`${HOME}/plugins/my-fp`)
  })

  it('未知 type 一律拒绝 —— 不许把任意子目录拼进 rm 的目标', () => {
    for (const t of ['webapp', 'plugins', '', '..', 'Skill']) {
      expect(marketItemDir(HOME, t, 'ok-slug')).toBeNull()
    }
  })

  it('不安全的 slug 一律拒绝(目录穿越/绝对路径/大写/空)', () => {
    for (const s of ['../../etc', '..', '/abs', 'a/b', 'UPPER', '', '-lead', 'x'.repeat(65)]) {
      expect(marketItemDir(HOME, 'skill', s)).toBeNull()
    }
  })

  it('拒绝时返回 null 而不是抛 —— 调用方靠 null 判定,不能靠 catch', () => {
    expect(() => marketItemDir(HOME, 'nope', '../x')).not.toThrow()
  })
})
