/**
 * Tangu 界面包(tangu-agent/ui/main.js,scripts/build-tangu-ui.mjs 打的)里 `require(id)` 的实现。界面热更新 4a 定约定,
 * 4b 的加载器求值时交进去:`new Function('require', code)(createHostRequire(SHARED_MODULES))`。
 *
 * - id 必须在共享表里;不在 = 包和这份宿主不配套(包是对着别的宿主构建的),直接抛,让加载器整版退回自带的界面。
 * - 包里的 import 经 esbuild 的 `__toESM` 取 default:命名空间对象没有 `__esModule`,会被当成 CJS、整个塞进 default,
 *   所以包一层带 `__esModule` 的对象;成员用 getter 转发,`export let` 的活绑定照旧是活的。
 */
export function createHostRequire(table: Record<string, object>): (id: string) => object {
  const cache = new Map<string, object>()
  return (id) => {
    let mod = cache.get(id)
    if (!mod) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) throw new Error(`The Tangu UI bundle asked the host for "${id}", which is not in the shared module table`)
      const ns = table[id] as Record<string, unknown>
      const wrapped: Record<string, unknown> = { __esModule: true }
      for (const key of Object.keys(ns)) Object.defineProperty(wrapped, key, { enumerable: true, get: () => ns[key] })
      cache.set(id, (mod = wrapped))
    }
    return mod
  }
}
