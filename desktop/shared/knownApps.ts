/**
 * Forsion 插件可声明依赖的本机应用(manifest.requiresApp = 表内 id)。
 * 安全边界:安装命令文本只存在于这张宿主表——插件(renderer 任意代码)只能引用 id,
 * 白名单外的 requiresApp 不渲染安装按钮,renderer 无法注入命令。
 * 执行走 env:run 通道(opaque installId + PATH 补全 + 中国镜像 env),detail 页 probe 由
 * renderer 直连(CSP 放行 localhost)。
 */
export interface KnownApp {
  name: string
  homepage: string
  /** HTTP 可达即视为「已安装并在运行」。 */
  probeUrl: string
  /** platform → 一键安装 shell 命令;缺平台 = 该平台降级「打开官网」。 */
  install: Partial<Record<'darwin' | 'win32' | 'linux', string>>
}

export const KNOWN_APPS: Record<string, KnownApp> = {
  activitywatch: {
    name: 'ActivityWatch',
    homepage: 'https://activitywatch.net',
    probeUrl: 'http://localhost:5600/api/0/info',
    install: {
      // cask 装完不自动起,接 open 让 probe 立刻能变绿
      darwin: 'brew install --cask activitywatch && open -a ActivityWatch',
      // 非交互参数必带:新机器第一次用 winget 会停在 msstore 源协议提示上(见 electron/envInstall.ts 头注释)。
      win32: 'winget install --id ActivityWatch.ActivityWatch -e --source winget --accept-source-agreements --accept-package-agreements',
      // linux 官方是 AppImage 手动落位,无一键 → 走官网
    },
  },
}
