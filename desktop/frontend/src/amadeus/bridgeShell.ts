/**
 * 桌面的 `window.amadeus` 转发壳(智库同步第 3 步 U3a,契约 step34 §3.3「换桥」)。
 * preload 把本机桥暴露成 `window.amadeusLocal`(contextBridge 暴露过的键能不能改写不赌),这里装一个恒定的
 * `window.amadeus` = Proxy → 当前 impl。渲染层 amadeus/api.ts 等在模块求值时就把 window.amadeus 捕获走了,
 * 以后换 impl(在线库)只换壳里那一格,捕获到的引用照样指向新桥。形状照手机 mobile/src/main.tsx 的壳。
 *
 * 这一版 impl 恒为 amadeusLocal:零行为变化。订阅重绑、换 impl、在线库都在后面的包里。
 *
 * ⚠️ 必须在 main.tsx 里紧跟 `./sandbox/seed` 之后、早于任何顺着 import 链走到 amadeus/api.ts 的模块,
 *    所以本文件只许 `import type`(同 seed 的纪律),装壳是模块求值时的副作用。
 * 这个键照 contextBridge 暴露键的属性装:只读、删不掉、可枚举(check:vaultmenu 段 A 实测 contextBridge 是这样,本机桥本身也是冻结的)——
 * 换成壳以后插件照样改不了、删不掉 window.amadeus;读写方法照旧落到(冻结的)本机桥上。
 * ⚠️ 没有 `window.amadeusLocal` 时什么都不做:网页(web/src/main.tsx 先赋云桥再进桌面启动)、台架、e2e、
 *    vault-integrity 的自带 preload 都自己设 window.amadeus,有的还是 contextBridge 的只读键 —— 不盖、也不在只读键上抛
 *    (ESM 是严格模式,模块求值抛错 = main.tsx 整个不跑、白屏)。
 */
import type { AmadeusApi } from '@amadeus-shared/ipc'

type ShellWindow = { amadeus?: AmadeusApi; amadeusLocal?: AmadeusApi }

/** 装上壳返回 true;没有本机桥、window.amadeus 已被别人装好、或者赋值失败都返回 false,不抛。 */
export function installBridgeShell(win: ShellWindow): boolean {
  const local = win.amadeusLocal
  if (!local) return false
  // 已经有这个键(哪怕值是 undefined、只读、是会抛的 getter)= 别人装的,不碰
  try { if (win.amadeus !== undefined || Object.prototype.hasOwnProperty.call(win, 'amadeus')) return false } catch { return false }
  // 当前 impl:今天恒为本机桥;第 3 批在线打开时换这一格(并由壳重绑订阅、带代次)
  const cur: { impl: AmadeusApi } = { impl: local }
  const impl = (): object => cur.impl as unknown as object
  // 目标是个空对象:每个 trap 都转发到 impl。读写删都落到 impl 上,和直接用本机桥一样(本机桥冻结,改方法照样抛 TypeError)。
  const shell = new Proxy({} as AmadeusApi, {
    get: (_t, k) => Reflect.get(impl(), k),
    has: (_t, k) => Reflect.has(impl(), k), // 渲染层多处用 `'x' in window.amadeus` 探能力
    ownKeys: () => Reflect.ownKeys(impl()),
    // configurable 必须为 true:空目标上没有这个属性,报不可配置会被 Proxy 不变式判非法直接抛
    getOwnPropertyDescriptor: (_t, k) => {
      const d = Reflect.getOwnPropertyDescriptor(impl(), k)
      return d ? { ...d, configurable: true } : undefined
    },
    set: (_t, k, v) => Reflect.set(impl(), k, v),
    deleteProperty: (_t, k) => Reflect.deleteProperty(impl(), k),
    defineProperty: (_t, k, d) => Reflect.defineProperty(impl(), k, d),
    getPrototypeOf: () => Reflect.getPrototypeOf(impl()),
  })
  try { Object.defineProperty(win, 'amadeus', { value: shell, writable: false, configurable: false, enumerable: true }) } catch { return false }
  return win.amadeus === shell
}

if (typeof window !== 'undefined') installBridgeShell(window as unknown as ShellWindow)
