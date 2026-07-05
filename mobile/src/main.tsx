/**
 * Tangu Mobile 入口:先装垫片(异步:native 读 Preferences token / web 读 localStorage),就绪后再
 * 动态 import 移动启动模块。动态 import 保证「垫片先于渲染层求值」。
 * 注意:不 import '@/main'(那是 desktop 的 Dockview 外壳启动);移动端走自己的 mobileEntry。
 */
import { installMobileShim } from './mobileShim'
import { createMobileAmadeusBridge } from './amadeus/mobileAmadeusBridge'

// window.amadeus 必须在任何 amadeus 模块被 import 之前**同步**挂好(amadeus/api.ts 模块求值即捕获 window.amadeus)。
// → 让 installEngine 的 `if (window.amadeus)` gate 放行 Amadeus Space + 视图。底层 = Capacitor Filesystem 本地 vault。
;(window as unknown as { amadeus: unknown }).amadeus = createMobileAmadeusBridge()

void installMobileShim().then((ok) => {
  if (ok) void import('./mobileEntry')
  // 未就绪:已发起登录(native 开系统浏览器 / web 跳 /auth),不挂载。
})
