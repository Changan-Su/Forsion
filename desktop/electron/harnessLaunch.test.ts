/**
 * 台架一律经 scripts/lib/launch-electron.cjs 起 Electron(macOS 上它追加 -ApplePersistenceIgnoreState YES,
 * 否则共用的 Electron.app 崩过一次后,之后每个台架都卡在「重新打开窗口」模态框里,firstWindow 超时)。
 * 这里钉住:scripts/ 里没有脚本再直接从 playwright-core 解构 _electron。
 */
import { readdirSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, parse, sep } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWorkspaceDir, setDevMode } from './forsionHome'
const { workspaceEnv } = require('../scripts/lib/launch-electron.cjs') as { workspaceEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | undefined }

const SCRIPTS = join(__dirname, '../scripts')
const ALLOWED = new Set([
  'lib/launch-electron.cjs', // 入口本身
  'env-install.windows-probe.cjs', // 只在 Windows CI 上跑,flag 只对 macOS 有意义
])

describe('Electron 台架启动入口', () => {
  it('scripts/ 里除入口外没有直接用 playwright 的 _electron', () => {
    const files = readdirSync(SCRIPTS, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.cjs')).map((f) => f.split(sep).join('/'))
    expect(files.length).toBeGreaterThan(50)
    const direct = files.filter((f) => !ALLOWED.has(f) && /\{[^}]*\b_electron\b[^}]*\}\s*=\s*require\(/.test(readFileSync(join(SCRIPTS, f), 'utf8')))
    expect(direct).toEqual([])
  })
})

/** 台架的默认工作区(默认笔记库 / Project 的根)跟着临时 TANGU_HOME 走,不落到开发者真实的 ~/Forsion-Dev。 */
describe('台架的默认工作区隔离', () => {
  afterEach(() => { vi.unstubAllEnvs(); setDevMode(false) })
  const home = join(tmpdir(), 'forsion-bench-x')
  const base = { ...process.env, FORSION_WORKSPACE_DIR: undefined }

  it('临时 TANGU_HOME → 补出它旁边的工作区,主进程的 defaultWorkspaceDir() 读到的就是这个', () => {
    const env = workspaceEnv({ ...base, TANGU_HOME: home })!
    expect(env.FORSION_WORKSPACE_DIR).toBe(`${home}-workspace`)
    // TANGU_HOME 叫 tangu 时 Forsion 根是它的父目录(forsionHomeDir 同一条规则):工作区放在根的旁边,不放进根里
    expect(workspaceEnv({ ...base, TANGU_HOME: join(home, 'tangu') })!.FORSION_WORKSPACE_DIR).toBe(`${home}-workspace`)
    vi.stubEnv('FORSION_WORKSPACE_DIR', env.FORSION_WORKSPACE_DIR!)
    setDevMode(true)
    expect(defaultWorkspaceDir()).toBe(`${home}-workspace`)
  })

  it('认漏了只会悄悄回落到真实目录,所以两种写法都要认:realpath 过的临时路径、继承来的空白值', () => {
    const realHome = join(realpathSync(tmpdir()), 'forsion-bench-x') // macOS:/private/var/folders/…,os.tmpdir() 给的是 /var/folders/…
    expect(workspaceEnv({ ...base, TANGU_HOME: realHome })!.FORSION_WORKSPACE_DIR).toBe(`${realHome}-workspace`)
    expect(workspaceEnv({ ...base, TANGU_HOME: home, FORSION_WORKSPACE_DIR: '  ' })!.FORSION_WORKSPACE_DIR).toBe(`${home}-workspace`)
  })

  it('调用方自己安排了的不动:显式给了工作区 / 覆写了 HOME / TANGU_HOME 不在临时目录下 / 没给 env', () => {
    expect(workspaceEnv({ ...base, TANGU_HOME: home, FORSION_WORKSPACE_DIR: '/x' })!.FORSION_WORKSPACE_DIR).toBe('/x')
    expect(workspaceEnv({ ...base, TANGU_HOME: home, HOME: home })!.FORSION_WORKSPACE_DIR).toBeUndefined()
    expect(workspaceEnv({ ...base, TANGU_HOME: join(parse(tmpdir()).root, 'forsion-not-tmp') })!.FORSION_WORKSPACE_DIR).toBeUndefined()
    expect(workspaceEnv({ ...base, TANGU_HOME: join(tmpdir(), 'tangu') })!.FORSION_WORKSPACE_DIR).toBeUndefined() // 根 = 临时目录本身
    expect(workspaceEnv({ ...base })!.FORSION_WORKSPACE_DIR).toBeUndefined()
    expect(workspaceEnv(undefined)).toBeUndefined()
  })
})
