import { expect, it } from 'vitest'
import { WebsiteUpdateProvider } from './websiteUpdateProvider'

it('serves the website installer record as update info, downloading through the website endpoint', async () => {
  const p = new WebsiteUpdateProvider(
    { provider: 'custom', installer: { version: '2.13.4', filename: 'Forsion-2.13.4-x64.exe', size: 100, sha512: 'abc==' }, downloadUrl: 'https://forsion.net/api/website/download/windows' },
    null,
    { executor: null as never, platform: 'win32', isUseMultipleRangeRequest: false },
  )
  const info = await p.getLatestVersion()
  expect(info).toMatchObject({ version: '2.13.4', sha512: 'abc==', files: [{ url: 'Forsion-2.13.4-x64.exe', size: 100 }] })
  const [file] = p.resolveFiles(info)
  expect(file.url.href).toBe('https://forsion.net/api/website/download/windows')
  expect(file.info.url).toBe('Forsion-2.13.4-x64.exe') // electron-updater 拿它当缓存文件名
})
