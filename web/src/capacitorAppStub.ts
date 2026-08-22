/**
 * 浏览器桩:web 手机端装载 mobile 的 MobileRoot 时顶替 `@capacitor/app`(vite alias)。
 * MobileRoot 对原生能力(backButton/minimizeApp)已有 `window.tangu?.mobile` 门控,浏览器里
 * 这些方法根本不会被调到 —— 桩只为了让静态 import 不把 Capacitor 拖进 web 依赖。
 */
export const App = {
  // 回调签名跟着真 Capacitor 走(appUrlOpen 带 { url },backButton 不带参 —— 零参回调照样可赋值)。
  // ⚠️ 写成 `(...args: unknown[]) => void` 会因逆变把 `({ url }) => …` 判成不可赋值。
  addListener: async (_event: string, _cb: (payload: { url: string }) => void): Promise<{ remove: () => void }> => ({ remove: () => {} }),
  minimizeApp: async (): Promise<void> => {},
  /** 冷启动深链。浏览器里没有「启动 URL」这回事,恒 undefined(与 Capacitor 未命中时同形)。 */
  getLaunchUrl: async (): Promise<{ url: string } | undefined> => undefined,
}
