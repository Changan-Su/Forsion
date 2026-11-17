/**
 * `ctx.internals.read / subscribe` 能读的宿主状态库登记表(2026-11-16+,见 pluginInternals.ts)。
 *
 * 叶子模块,不引任何东西:状态库自己(比如 stores/appStore.ts)在模块末尾登记一行,不用反过来引插件宿主 ——
 * 插件宿主的导入图很大,让状态库引它容易绕成环,环上谁先求值谁就拿到一个还没初始化的绑定。
 * 名字是给插件作者看的短名(`page`、`app`……);内容跟着宿主内部走,不稳定,不写文档。
 */

export interface InternalStore {
  getState(): unknown
  subscribe(listener: () => void): () => void
}

const stores = new Map<string, InternalStore>()

/** 登记一个状态库。同名后到的覆盖先到的(热重载时模块会再求值一次)。 */
export function provideInternalStore(name: string, store: InternalStore): void {
  stores.set(name, store)
}

export function internalStore(name: string): InternalStore | undefined {
  return stores.get(name)
}

export function internalStoreNames(): string[] {
  return [...stores.keys()].sort()
}
