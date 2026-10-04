/**
 * tangu CLI 自动安装:shim 生成 / 标记块 upsert 幂等 / ensureCliInstalled 端到端(tmpdir 假 App 布局)。
 * cliInstall.ts 顶层不 import electron,可直测(marketInstall.test.ts 同范式)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  posixShimScript, appImageShimScript, winShimScript, upsertMarkedBlock, ensureCliInstalled,
  CLI_BLOCK_BEGIN, CLI_BLOCK_END,
} from './cliInstall'

describe('shim 脚本生成', () => {
  it('posix:ELECTRON_RUN_AS_NODE + 双引号包路径 + 透传 "$@"', () => {
    const s = posixShimScript('/Applications/Tangu Agent 2.0.app/Contents/MacOS/Tangu Agent 2.0', '/x/resources/tangu-server/dist/tui/main.js')
    expect(s.startsWith('#!/bin/sh\n')).toBe(true)
    expect(s).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(s).toContain('"/Applications/Tangu Agent 2.0.app/Contents/MacOS/Tangu Agent 2.0"')
    expect(s).toContain('"$@"')
  })

  it('appimage:用 $APPIMAGE 真实路径 + -e 自定位 bootstrap(argv splice 补脚本位),且 bootstrap 内无单引号', () => {
    const s = appImageShimScript('/home/u/Applications/Tangu.AppImage')
    expect(s).toContain('"/home/u/Applications/Tangu.AppImage"')
    expect(s).toContain('process.argv.splice(1,0,"tangu")')
    expect(s).toContain('tangu-server')
    const boot = s.split("-e '")[1].split("' --")[0]
    expect(boot.includes("'")).toBe(false) // 单引号会截断 sh 引用
  })

  it('win:CRLF + set ELECTRON_RUN_AS_NODE + %*', () => {
    const s = winShimScript('C:\\Users\\u\\AppData\\Local\\Programs\\tangu\\Tangu.exe', 'C:\\x\\dist\\tui\\main.js')
    expect(s).toContain('\r\n')
    expect(s).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(s).toContain('%*')
  })
})

describe('upsertMarkedBlock', () => {
  const line = 'export PATH="/home/u/.tangu/bin:$PATH"'

  it('空文件追加 → 再跑幂等不变', () => {
    const first = upsertMarkedBlock('', line)
    expect(first.changed).toBe(true)
    expect(first.content).toContain(CLI_BLOCK_BEGIN)
    expect(first.content).toContain(CLI_BLOCK_END)
    const again = upsertMarkedBlock(first.content, line)
    expect(again.changed).toBe(false)
    expect(again.content).toBe(first.content)
  })

  it('已有内容(无尾换行)→ 空行分隔追加,不动原内容', () => {
    const r = upsertMarkedBlock('# my rc\nalias ll="ls -l"', line)
    expect(r.content.startsWith('# my rc\nalias ll="ls -l"\n\n')).toBe(true)
    expect(r.content).toContain(line)
  })

  it('块已存在但内容过期 → 原位替换', () => {
    const stale = `pre\n${CLI_BLOCK_BEGIN}\nexport PATH="/old:$PATH"\n${CLI_BLOCK_END}\npost\n`
    const r = upsertMarkedBlock(stale, line)
    expect(r.changed).toBe(true)
    expect(r.content).toContain(line)
    expect(r.content).not.toContain('/old:')
    expect(r.content.startsWith('pre\n')).toBe(true)
    expect(r.content.trimEnd().endsWith('post')).toBe(true)
  })
})

describe('ensureCliInstalled(tmp 假 App 布局)', () => {
  let root: string
  const logs: string[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tangu-cli-'))
    logs.length = 0
    // 假 resources:入口文件必须存在
    mkdirSync(join(root, 'res', 'tangu-server', 'dist', 'tui'), { recursive: true })
    writeFileSync(join(root, 'res', 'tangu-server', 'dist', 'tui', 'main.js'), '// entry')
  })
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const input = () => ({
    isPackaged: true,
    platform: 'darwin' as NodeJS.Platform,
    execPath: join(root, 'App.app', 'Contents', 'MacOS', 'App'),
    resourcesPath: join(root, 'res'),
    appImagePath: null,
    homeDir: join(root, 'home'),
    tanguHome: join(root, 'home', '.tangu'),
    log: (m: string) => logs.push(m),
  })

  it('dev 态跳过', async () => {
    const r = await ensureCliInstalled({ ...input(), isPackaged: false })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('dev')
  })

  it('入口缺失 → 拒绝并说明', async () => {
    const r = await ensureCliInstalled({ ...input(), resourcesPath: join(root, 'nowhere') })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('入口不存在')
  })

  it('写 shim(755)+ .zprofile/.bash_profile PATH 块;二次运行零改动;execPath 变化自愈重写', async () => {
    mkdirSync(join(root, 'home'), { recursive: true })
    const r = await ensureCliInstalled(input())
    expect(r.ok).toBe(true)
    const shim = join(root, 'home', '.tangu', 'bin', 'tangu')
    expect(existsSync(shim)).toBe(true)
    // Windows does not expose POSIX executable permission bits.
    if (process.platform !== 'win32') expect(statSync(shim).mode & 0o755).toBe(0o755)
    expect(readFileSync(shim, 'utf-8')).toContain('ELECTRON_RUN_AS_NODE=1')
    const zp = readFileSync(join(root, 'home', '.zprofile'), 'utf-8')
    expect(zp).toContain(CLI_BLOCK_BEGIN)
    expect(zp).toContain(join(root, 'home', '.tangu', 'bin'))
    expect(existsSync(join(root, 'home', '.bash_profile'))).toBe(true)

    // 幂等:第二次跑不产生任何写日志
    logs.length = 0
    await ensureCliInstalled(input())
    expect(logs.length).toBe(0)

    // App 被移动 → shim 内容比对不一致 → 自愈重写
    const moved = await ensureCliInstalled({ ...input(), execPath: join(root, 'Elsewhere.app', 'Contents', 'MacOS', 'App') })
    expect(moved.ok).toBe(true)
    expect(readFileSync(shim, 'utf-8')).toContain('Elsewhere.app')
  })

  it('linux + AppImage → shim 用 $APPIMAGE 自定位;写 .bashrc/.profile,不凭空造 .zprofile', async () => {
    mkdirSync(join(root, 'home'), { recursive: true })
    const r = await ensureCliInstalled({
      ...input(),
      platform: 'linux' as NodeJS.Platform,
      appImagePath: join(root, 'Tangu.AppImage'),
    })
    expect(r.ok).toBe(true)
    const shim = readFileSync(join(root, 'home', '.tangu', 'bin', 'tangu'), 'utf-8')
    expect(shim).toContain('Tangu.AppImage')
    expect(shim).toContain('process.argv.splice')
    expect(existsSync(join(root, 'home', '.bashrc'))).toBe(true)
    expect(existsSync(join(root, 'home', '.profile'))).toBe(true)
    expect(existsSync(join(root, 'home', '.zprofile'))).toBe(false)
  })

  it('fish 目录存在 → 写 conf.d/tangu.fish', async () => {
    mkdirSync(join(root, 'home', '.config', 'fish'), { recursive: true })
    await ensureCliInstalled(input())
    const f = join(root, 'home', '.config', 'fish', 'conf.d', 'tangu.fish')
    expect(existsSync(f)).toBe(true)
    expect(readFileSync(f, 'utf-8')).toContain(join(root, 'home', '.tangu', 'bin'))
  })
})
