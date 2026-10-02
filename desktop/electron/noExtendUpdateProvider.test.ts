import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from 'builder-util-runtime'
import { NoExtendUpdateProvider } from './noExtendUpdateProvider'
const { SemVer } = require('semver')

afterEach(() => vi.unstubAllEnvs())

const feed = `<feed>${['2.12.0-beta.1', '2.11.5'].map((v) => `<entry><title>${v}</title><link href="https://github.com/Changan-Su/Forsion/releases/tag/v${v}"/><content>Notes</content></entry>`).join('')}</feed>`

function provider(platform: 'win32' | 'linux', beta = false, missingFeed = false) {
  const requested: string[] = []
  const executor = {
    request: async (options: { path: string }) => {
      requested.push(options.path)
      if (options.path.endsWith('.atom')) return feed
      if (options.path.endsWith('/latest')) return JSON.stringify({ tag_name: 'v2.11.5' })
      if (missingFeed || options.path.includes('/beta-no-extend')) throw new HttpError(404)
      return 'version: 2.11.5\nfiles:\n  - url: Forsion-NoExtend-2.11.5-x64.exe\n    sha512: dGVzdA==\n'
    },
  }
  const updater = { channel: beta ? 'beta' : 'latest', allowPrerelease: beta, currentVersion: new SemVer('2.11.4'), fullChangelog: false }
  const p = new NoExtendUpdateProvider(
    { provider: 'custom', owner: 'Changan-Su', repo: 'Forsion' },
    updater as never,
    { executor: executor as never, platform, isUseMultipleRangeRequest: false },
  )
  return { p, requested }
}

describe('NoExtend GitHub updates', () => {
  it.each(['win32', 'linux'] as const)('stable %s reads only its distribution manifest', async (platform) => {
    vi.stubEnv('TEST_UPDATER_ARCH', 'x64')
    const { p, requested } = provider(platform)
    const info = await p.getLatestVersion()
    expect(requested.at(-1)).toBe(`/Changan-Su/Forsion/releases/download/v2.11.5/latest-no-extend${platform === 'linux' ? '-linux' : ''}.yml`)
    expect(p.resolveFiles(info)[0].url.pathname).toContain('/Forsion-NoExtend-')
  })

  it.each(['win32', 'linux'] as const)('beta %s fallback remains in NoExtend', async (platform) => {
    vi.stubEnv('TEST_UPDATER_ARCH', 'x64')
    const { p, requested } = provider(platform, true)
    await p.getLatestVersion()
    const suffix = platform === 'linux' ? '-linux' : ''
    expect(requested.slice(-2)).toEqual([
      `/Changan-Su/Forsion/releases/download/v2.12.0-beta.1/beta-no-extend${suffix}.yml`,
      `/Changan-Su/Forsion/releases/download/v2.12.0-beta.1/latest-no-extend${suffix}.yml`,
    ])
    expect(requested.some((path) => /\/(latest|beta)(-linux)?\.yml$/.test(path))).toBe(false)
  })

  it('missing NoExtend feeds fail without switching to the full installer', async () => {
    const { p, requested } = provider('win32', true, true)
    await expect(p.getLatestVersion()).rejects.toThrow('latest-no-extend.yml')
    expect(requested.filter((path) => path.endsWith('.yml')).every((path) => path.includes('-no-extend'))).toBe(true)
  })
})
