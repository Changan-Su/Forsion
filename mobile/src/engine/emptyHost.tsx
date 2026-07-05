/**
 * Dockview 外壳的空 stub。vite resolveId 插件把 desktop 的 engine/Shell.tsx 与 engine/WorkspaceHost.tsx
 * 都指到这里 —— 移动端不用 Dockview,改由 MobileShell 单列渲染。barrel 仍 `export { Shell } from './Shell'`,
 * 故这里必须导出同名 Shell/WorkspaceHost(空组件),以免 Dockview 经 barrel 的 re-export 被拽进 bundle。
 */
export const Shell = (): null => null
export const WorkspaceHost = (): null => null
