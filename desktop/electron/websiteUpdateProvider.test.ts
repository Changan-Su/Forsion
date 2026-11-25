import { expect, it } from 'vitest'
import { websiteDownload } from '../shared/updateSource'
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

it('always asks the object storage for one range at a time (it answers multi-range requests with only the first range)', () => {
  const p = new WebsiteUpdateProvider(
    { provider: 'custom', installer: { version: '2.13.4', filename: 'a.exe' }, downloadUrl: 'https://forsion.net/api/website/download/windows' },
    null,
    { executor: null as never, platform: 'win32', isUseMultipleRangeRequest: true }, // electron-updater 给 custom 源的缺省
  )
  expect(p.isUseMultipleRangeRequest).toBe(false)
})

it('the versioned address yields the blockmap addresses the server answers, for the new and the running version', async () => {
  const installer = { version: '2.14.4', filename: 'Forsion-2.14.4-x64.exe', size: 100, sha512: 'abc==', blockmap: true }
  const { url } = websiteDownload('https://forsion.net/api', 'windows', installer)
  const p = new WebsiteUpdateProvider({ provider: 'custom', installer, downloadUrl: url }, null, { executor: null as never, platform: 'win32', isUseMultipleRangeRequest: true })
  const [file] = p.resolveFiles(await p.getLatestVersion())
  // electron-updater 6.8.9 AppUpdater.differentialDownloadInstaller 就是这么调的:(下载地址, 当前版本, 新版本)
  const [oldMap, newMap] = await p.getBlockMapFiles(file.url, '2.14.3', '2.14.4')
  expect(newMap.href).toBe('https://forsion.net/api/website/download/windows/2.14.4/Forsion-2.14.4-x64.exe.blockmap')
  expect(oldMap.href).toBe('https://forsion.net/api/website/download/windows/2.14.3/Forsion-2.14.3-x64.exe.blockmap')
  // NSIS 按下载地址的 .exe 结尾挑文件、也拿它当缓存文件名
  expect(file.url.pathname.endsWith('.exe')).toBe(true)
})
