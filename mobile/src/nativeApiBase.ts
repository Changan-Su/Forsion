/**
 * 安卓 App(native 分支)的 Forsion 网关源 —— 唯一一份规则(P1-K8,评审 P2)。两处共用:
 *   - src/capacitorAuth.ts 的 apiOrigin() / apiBase():JS 渲染层与 mobileShim 用的 cloudApiBase;
 *   - vite.config.ts 的 nativeConfig():构建期写进 forsion-native.json,原生 UnitPlugin 只认这份(绝不经 JS 传入)。
 * mobileShim 启动时断言两者逐字相等(unitBridge.ts),不等则中继失败关闭;这里合成一份就不会漂。
 * 仪器:scripts/unit-bridge.test.cjs 按一张 VITE_API_ORIGIN 表比对两条真实代码路径的产出。
 *
 * 规则:VITE_API_ORIGIN 覆盖(空串按未设),缺省生产网关;去一个尾斜杠。无依赖(vite.config.ts 也 import 它)。
 */
export const PROD_API_ORIGIN = 'https://api.forsion.net'

export function nativeApiOrigin(explicit: string | null | undefined): string {
  return String(explicit || PROD_API_ORIGIN).replace(/\/$/, '')
}
