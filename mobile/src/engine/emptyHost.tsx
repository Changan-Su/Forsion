/**
 * Dockview 外壳的空 stub。vite resolveId 插件把 desktop 的 engine/Shell.tsx 与 engine/WorkspaceHost.tsx
 * 都指到这里 —— 移动端不用 Dockview,改由 MobileShell 单列渲染。barrel 仍 `export { Shell } from './Shell'`,
 * 故这里必须导出同名 Shell/WorkspaceHost(空组件),以免 Dockview 经 barrel 的 re-export 被拽进 bundle。
 *
 * ⚠️ **barrel 里每多一个从这两个模块 re-export 的名字,这里就得补一个同名 stub** ——
 * 少一个,移动端 `vite build` 直接 rollup 报 "X is not exported by emptyHost.tsx"。
 * 而 desktop 的 tsc/vitest 都碰不到这条路径,只有 CI 的 build-android 会红(v2.7.0 就这么挂的)。
 */
export const Shell = (): null => null
export const WorkspaceHost = (): null => null

/** 落点即开的拖拽发起(桌面 Dockview 专属)。移动端没有可停靠的落区,空实现即可。 */
export const startOpenDrag = (_dt: DataTransfer | null, _spec: { type: string; params?: Record<string, unknown> }): void => {}
