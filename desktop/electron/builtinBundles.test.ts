/**
 * 内置包清单(builtinBundles.json)与它的消费者绑在一起:漏一处 = 安装包静默不带那个包 / 更新器永远不查它。
 * 跑在 check-unit(PR 路径)上,别只留在打 tag 才跑的全量 npm test 里。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cmpVersion } from '@amadeus-shared/ipc'
import { BUILTIN_BUNDLES } from './builtinPlugins'

const desktop = resolve(__dirname, '..')
const read = (rel: string): string => readFileSync(join(desktop, rel), 'utf8')

describe('builtinBundles.json 单一来源', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }

  it('每个内置包:desktop/package.json 钉精确正式版;id 合法;platforms 非空;带主进程半身的钉了公钥与入口', () => {
    for (const b of BUILTIN_BUNDLES) {
      expect(pkg.dependencies?.[b.pkg], `${b.pkg} 不在 desktop/package.json dependencies`).toMatch(/^\d+\.\d+\.\d+$/)
      // 宿主删掉了某块原生实现 → 钉的版本必须 ≥ 提供那块的包版本,否则干净构建静默丢功能(Codex:钉 0.1 配删了 Connect 的 main.ts)
      if (b.minVersion) expect(cmpVersion(pkg.dependencies![b.pkg], b.minVersion), `${b.pkg} 钉的 ${pkg.dependencies![b.pkg]} 低于宿主要求的 ${b.minVersion}`).toBeGreaterThanOrEqual(0)
      expect(b.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/)
      expect(b.platforms.length).toBeGreaterThan(0)
      for (const p of b.platforms) expect(['darwin', 'win32', 'linux']).toContain(p)
      if (b.desktop) {
        expect(b.desktop.entry).toMatch(/^[a-z0-9][\w./-]*\.m?js$/i)
        expect(b.desktop.signingKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\w+/=\n]+-----END PUBLIC KEY-----\n$/)
      }
    }
  })

  it('Dependabot 白名单覆盖整张清单(否则 npm 发了新版没人提 PR)', () => {
    const allow = read('../.github/dependabot.yml').match(/dependency-name:\s*'([^']+)'/g)?.map((m) => m.replace(/.*'([^']+)'/, '$1')) ?? []
    for (const b of BUILTIN_BUNDLES) expect(allow, b.pkg).toContain(b.pkg)
  })

  it('electron-builder 与 release-content 都读清单,不再各自写死包名', () => {
    for (const file of ['electron-builder.config.cjs', 'scripts/release-content.check.cjs']) {
      const src = read(file)
      expect(src, file).toContain("require('./electron/builtinBundles.json')".replace('./electron', file.startsWith('scripts') ? '../electron' : './electron'))
      expect(src, file).not.toMatch(/node_modules\/@forsion\/[a-z-]+/)
    }
  })

  it('清单里每个包的 pkg 唯一、id 唯一', () => {
    expect(new Set(BUILTIN_BUNDLES.map((b) => b.pkg)).size).toBe(BUILTIN_BUNDLES.length)
    expect(new Set(BUILTIN_BUNDLES.map((b) => b.id)).size).toBe(BUILTIN_BUNDLES.length)
  })
})
