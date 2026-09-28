/**
 * 台架一律经 scripts/lib/launch-electron.cjs 起 Electron(macOS 上它追加 -ApplePersistenceIgnoreState YES,
 * 否则共用的 Electron.app 崩过一次后,之后每个台架都卡在「重新打开窗口」模态框里,firstWindow 超时)。
 * 这里钉住:scripts/ 里没有脚本再直接从 playwright-core 解构 _electron。
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const SCRIPTS = join(__dirname, '../scripts')
const ALLOWED = new Set([
  'lib/launch-electron.cjs', // 入口本身
  'env-install.windows-probe.cjs', // 只在 Windows CI 上跑,flag 只对 macOS 有意义
])

describe('Electron 台架启动入口', () => {
  it('scripts/ 里除入口外没有直接用 playwright 的 _electron', () => {
    const files = readdirSync(SCRIPTS, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.cjs'))
    expect(files.length).toBeGreaterThan(50)
    const direct = files.filter((f) => !ALLOWED.has(f) && /\{[^}]*\b_electron\b[^}]*\}\s*=\s*require\(/.test(readFileSync(join(SCRIPTS, f), 'utf8')))
    expect(direct).toEqual([])
  })
})
