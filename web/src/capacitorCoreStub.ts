/**
 * 浏览器桩:web 手机端装载 mobile 壳时顶替 `@capacitor/core`(vite alias),与 capacitorAppStub 同一条纪律。
 *
 * ⚠️ 本机 `npm run build` 是**假绿**:vite 会从 mobile/src 一路向上找到 `mobile/node_modules/@capacitor/core`,
 *    而 web 镜像里只有 `/app/node_modules`(web 自己的依赖,没有 capacitor)——于是只有 CI 会红:
 *    `[vite]: Rollup failed to resolve import "@capacitor/core"`(2026-08-22 build-web 实翻)。
 *    加了别名之后两边都走这份桩,本机与 CI 才同构。
 *
 * spaceShortcuts 只用两样:`isNativePlatform()`(浏览器恒 false,整个模块随即早退)、
 * `registerPlugin` 拿原生插件句柄(浏览器里永远调不到,给个恒 reject 的壳即可)。
 */
export const Capacitor = {
  isNativePlatform: (): boolean => false,
  getPlatform: (): string => 'web',
  isPluginAvailable: (_name: string): boolean => false,
}

export function registerPlugin<T>(name: string): T {
  const fail = async (): Promise<never> => {
    throw new Error(`Capacitor plugin "${name}" 在浏览器里不可用`)
  }
  return new Proxy({}, { get: () => fail }) as T
}
