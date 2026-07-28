/**
 * 只开一条规则:react-hooks/rules-of-hooks。跑法:`npm run check:hooks`。
 *
 * 起因(2026-07-27,codex High-1):在 `if (!root) return <ProjectPicker/>` **之后**加了
 * `useRef/useEffect` —— 选项目那一下 hook 数量变化,React 直接崩,而 tsc / vitest / 真 Electron
 * 契约检查**全绿**(那几样都不渲染这个组件)。这类错误只有 AST 层面看得出来。
 *
 * ponytail: 刻意不开风格 / exhaustive-deps 等其余规则 —— 在这么大的既有代码库里会刷出成百上千条
 * 噪声,然后没人再看这个命令。只留一条「红了就是真的会崩」的规则。
 *
 * 放在 build/ 而不是仓根 eslint.config.mjs:仓库装了保护默认 lint 配置的 hook,这里是**新增**
 * 检查而非放宽既有规则,所以走独立路径 + `--config`。要挪到仓根随时可以。
 */
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  { ignores: ['**/node_modules/**', 'out/**', 'dist/**', 'release/**', '**/*.d.ts'] },
  {
    files: ['frontend/src/**/*.{ts,tsx}', '../lcl/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    // 只注册插件、不开它的规则:代码里既有的 `eslint-disable @typescript-eslint/*` 注释在
    // 规则未注册时会报「Definition for rule not found」,那是噪声不是问题。
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
    // 同理:那些 disable 注释针对的是本配置没开的规则,别拿「未生效的 disable」刷屏。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
]
