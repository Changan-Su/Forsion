/**
 * 浏览器桩:web 手机端装载 mobile 的 MobileRoot 时顶替 `@capacitor/app`(vite alias)。
 * MobileRoot 对原生能力(backButton/minimizeApp)已有 `window.tangu?.mobile` 门控,浏览器里
 * 这些方法根本不会被调到 —— 桩只为了让静态 import 不把 Capacitor 拖进 web 依赖。
 */
export const App = {
  addListener: async (_event: string, _cb: (...args: unknown[]) => void): Promise<{ remove: () => void }> => ({ remove: () => {} }),
  minimizeApp: async (): Promise<void> => {},
}
