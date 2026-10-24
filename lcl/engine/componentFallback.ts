/**
 * Dockview components 表的兜底:布局里存着、此刻却没注册的组件名(插件还没就位 / 已关掉),一律交给 fallback。
 *
 * 为什么只能在表这一层:dockview-react 建 panel 时只读一次 `components[name]`,把结果捕获进
 * ReactPanelContentPart(之后注册表再变、表再重建,已建好的 panel 也换不掉)。读到 undefined 就当场抛
 * 「Only React.memo… are accepted as components」,整次 fromJSON / openView 跟着断。
 * 侧栏 panel 的组件名就是视图类型(主区一律 '__frame'),所以这一半最容易撞上。
 */
export function withComponentFallback<T>(map: Record<string, T>, fallback: T): Record<string, T> {
  // `in` 而不是 hasOwnProperty:原型上的 toString 之类照旧拿原值,只有真缺席的名字才落到 fallback。
  return new Proxy(map, { get: (m, k) => (typeof k === 'string' && !(k in m) ? fallback : Reflect.get(m, k)) })
}
