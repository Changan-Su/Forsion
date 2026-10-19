import { Provider, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import type { ResolvedUpdateFileInfo } from 'electron-updater/out/types.js'
import type { CustomPublishOptions, UpdateInfo } from 'builder-util-runtime'
import type { WebsiteInstaller } from '../shared/updateSource'

/**
 * 官网下载源(只给 Windows 标准包用):版本、大小、sha512 都来自官网 `/api/website/config` 那条安装包记录,不读 yml。
 * 文件地址是官网下载接口(302 到 OSS 签名链接,electron-updater 会跟着跳);缓存文件名取 info.url = 安装包文件名
 * (下载地址不以 .exe 结尾时 electron-updater 就用它)。sha512 照常校验,没有 sha512 的记录 updater.ts 根本不会选这边。
 */
export class WebsiteUpdateProvider extends Provider<UpdateInfo> {
  constructor(private readonly options: CustomPublishOptions, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions)
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const it = this.options.installer as WebsiteInstaller
    const sha512 = it.sha512 || ''
    return { version: it.version, files: [{ url: it.filename, sha512, size: it.size }], path: it.filename, sha512, releaseDate: '' }
  }

  resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
    return info.files.map((f) => ({ url: new URL(String(this.options.downloadUrl)), info: f }))
  }
}
