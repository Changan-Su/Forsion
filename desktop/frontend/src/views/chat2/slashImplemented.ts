/**
 * Composer2 里真正接了 handler 的命令名单。
 *
 * 与 Composer2 内的 `handlers` 表**必须一一对应** —— 这份清单只是为了让 slashCatalog.test.ts 能在
 * 不渲染组件的前提下断言「catalog 声明了 desktop 的命令,本端确实实现了」。加命令的顺序:
 *   1. tangu-agent/src/core/commandCatalog.ts 加条目（TUI 同时吃到）+ `npm run sync:commands`
 *   2. Composer2 的 handlers 加实现
 *   3. 这里补上名字
 * 漏掉第 3 步测试会红,漏掉第 2 步同样会红 —— 这就是这份「重复」清单存在的理由。
 */
export const DESKTOP_IMPLEMENTED: string[] = [
  '/stop',
  '/new',
  '/branch',
  '/compact',
  '/plan',
  '/voice',
  '/model',
  '/loop',
  '/verify',
  '/think',
  '/approval',
  '/help',
  '/skills',
  '/tools',
  '/agents',
  '/agent',
  '/mcp',
  '/plugins',
  '/memory',
  '/config',
  '/login',
  '/historian',
  '/muse',
  '/groupchat',
  '/sessions',
  '/cost',
  '/status',
  '/copy',
  '/retry',
  '/export',
]
