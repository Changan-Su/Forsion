import { defineConfig } from 'vitest/config';

// 最小回归地板:纯函数单测 + 工具定义快照。esbuild 转译 TS(不做类型检查;
// 类型检查仍由 `npm run typecheck` / `npm run build` 负责,且 tsconfig 已排除 *.test.ts 不进 dist)。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.{ts,mjs}'],
    // browser_* 缺省会自动接管本机开了远程调试的 Chrome:单测绝不能连到开发者正在用的浏览器(每连一次它弹一次授权框)
    env: { TANGU_BROWSER_CDP: 'off' },
    // 插件生命周期测试的临时插件目录交给 Node 原生加载:生产里插件就是原生 import 的,换代靠 Node 的模块钩子
    // 把 ?tangu-gen 沿插件模块图往下传 —— 让 vitest 自己的运行器转译执行,钩子管不到,测的就不是真路径了。
    server: { deps: { external: [/\/tangu-lifecycle-[^/]+\/plugins\//] } },
  },
});
