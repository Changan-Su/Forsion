/** ~/.tangu → ~/.forsion 迁移:改名/兼容软链/并存保守/幂等 + 两层布局 migrateEngineData。 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratePair, migrateEngineData, setDevMode, forsionHomeDir, defaultWorkspaceDir } from './forsionHome'

const noop = (): void => {}
const setup = (): { old: string; nu: string } => {
  const root = mkdtempSync(join(tmpdir(), 'fh-'))
  return { old: join(root, '.tangu'), nu: join(root, '.forsion') }
}

describe('migratePair', () => {
  it('真目录改名 + 旧位留软链,内容无损', () => {
    const { old, nu } = setup()
    mkdirSync(join(old, 'skills'), { recursive: true })
    writeFileSync(join(old, 'config.json'), '{"a":1}')
    migratePair(old, nu, { log: noop })
    expect(readFileSync(join(nu, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(lstatSync(old).isSymbolicLink()).toBe(true)
    expect(realpathSync(join(old, 'skills'))).toBe(realpathSync(join(nu, 'skills'))) // 旧路径经链可达
  })

  it('全新用户(两处皆无):ensureNew 建新目录并补链;不 ensureNew 则不动', () => {
    const a = setup()
    migratePair(a.old, a.nu, { ensureNew: true, log: noop })
    expect(existsSync(a.nu)).toBe(true)
    expect(lstatSync(a.old).isSymbolicLink()).toBe(true)
    const b = setup()
    migratePair(b.old, b.nu, { log: noop })
    expect(existsSync(b.nu)).toBe(false)
    expect(existsSync(b.old)).toBe(false)
  })

  it('并存(两边都是真目录):保守不动、不建链', () => {
    const { old, nu } = setup()
    mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'x'), '1')
    mkdirSync(nu, { recursive: true }); writeFileSync(join(nu, 'y'), '2')
    migratePair(old, nu, { log: noop })
    expect(lstatSync(old).isDirectory() && !lstatSync(old).isSymbolicLink()).toBe(true)
    expect(existsSync(join(old, 'x')) && existsSync(join(nu, 'y'))).toBe(true)
  })

  it('幂等:迁移后再跑不变形', () => {
    const { old, nu } = setup()
    mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'z'), '3')
    migratePair(old, nu, { ensureNew: true, log: noop })
    migratePair(old, nu, { ensureNew: true, log: noop })
    expect(lstatSync(old).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(nu, 'z'), 'utf8')).toBe('3')
  })
})

describe('migrateEngineData(两层布局:顶层引擎条目 → tangu/)', () => {
  it('引擎条目搬进 tangu/,共享域与 desktop 自有内容留顶层;纯 rename 不留链', () => {
    const home = mkdtempSync(join(tmpdir(), 'fh-eng-'))
    mkdirSync(join(home, 'agents', 'muse'), { recursive: true })
    writeFileSync(join(home, 'agents', 'muse', 'config.toml'), 'name = "Muse"')
    writeFileSync(join(home, 'state.db'), 'db')
    writeFileSync(join(home, 'USER.md'), 'u')
    // 共享域 + desktop 自有:必须原地不动
    writeFileSync(join(home, 'auth.json'), '{}')
    writeFileSync(join(home, 'config.json'), '{}')
    mkdirSync(join(home, 'activity'), { recursive: true })
    mkdirSync(join(home, 'themes', 't'), { recursive: true })
    migrateEngineData(noop, home)
    expect(readFileSync(join(home, 'tangu', 'agents', 'muse', 'config.toml'), 'utf8')).toBe('name = "Muse"')
    expect(existsSync(join(home, 'tangu', 'state.db'))).toBe(true)
    expect(existsSync(join(home, 'tangu', 'USER.md'))).toBe(true)
    expect(existsSync(join(home, 'agents'))).toBe(false) // 不留链,顶层干净
    expect(existsSync(join(home, 'auth.json'))).toBe(true)
    expect(existsSync(join(home, 'config.json'))).toBe(true)
    expect(existsSync(join(home, 'activity'))).toBe(true)
    expect(existsSync(join(home, 'themes', 't'))).toBe(true)
  })

  it('幂等 + 并存保守(旧位保留人工合并)', () => {
    const home = mkdtempSync(join(tmpdir(), 'fh-eng-'))
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'old.md'), 'old')
    mkdirSync(join(home, 'tangu', 'skills'), { recursive: true })
    writeFileSync(join(home, 'tangu', 'skills', 'new.md'), 'new')
    migrateEngineData(noop, home)
    migrateEngineData(noop, home)
    expect(readFileSync(join(home, 'skills', 'old.md'), 'utf8')).toBe('old') // 并存:旧位不动
    expect(readFileSync(join(home, 'tangu', 'skills', 'new.md'), 'utf8')).toBe('new')
  })
})

describe('dev 态目录隔离', () => {
  it('setDevMode(true) → ~/.forsion-dev 与 ~/Forsion-Dev;关掉恢复', () => {
    setDevMode(true)
    expect(forsionHomeDir().endsWith('.forsion-dev')).toBe(true)
    expect(defaultWorkspaceDir().endsWith('Forsion-Dev')).toBe(true)
    setDevMode(false)
    expect(forsionHomeDir().endsWith('.forsion')).toBe(true)
    expect(defaultWorkspaceDir().endsWith('Forsion')).toBe(true)
  })
})
