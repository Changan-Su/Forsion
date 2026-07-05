import { defineConfig } from 'vitest/config';

// 最小回归地板:纯函数单测 + 工具定义快照。esbuild 转译 TS(不做类型检查;
// 类型检查仍由 `npm run typecheck` / `npm run build` 负责,且 tsconfig 已排除 *.test.ts 不进 dist)。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.{ts,mjs}'],
  },
});
