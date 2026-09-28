/**
 * EngineTarget 品牌的**编译期负对照**(P1-K6 §3.9 第 1 道守卫;被 `npm run typecheck` 覆盖,不参与打包)。
 *
 * 每一行 `@ts-expect-error` 都是一条断言「这里必须编译失败」:哪天品牌被削弱(比如有人把 `[ENGINE_TARGET]`
 * 从接口里删了、或把 unique symbol 导出了),下面的伪造就会**编译通过**,expect-error 随之变成「未使用」→ tsc 红。
 *
 * Phase A(K6-S0 起):服务函数仍收 `EngineArg`(含 legacy cfg),所以这里只钉「造不出目标」。
 * Phase B(K6-S3 删 LegacyCfg 后)再加一行:`// @ts-expect-error` + `listSessions(cfg)`(整份 cfg 不再能当目标)。
 */
import type { EngineTarget, TargetKey, TargetRef } from './target'

// @ts-expect-error 对象字面量凑不齐只在 target.ts 里声明的 unique symbol 品牌 —— 只有 mintTarget 能造目标
export const forgedLiteral: EngineTarget = {
  key: 'home', ref: { kind: 'home' }, via: 'local', base: 'http://127.0.0.1:1', unitBase: null,
  headers: async () => ({}),
}

// @ts-expect-error 目标键只有 'home' 与 'unit:<id>' 两种形态
export const badKey: TargetKey = 'cloud'

// @ts-expect-error unit 位置必须带 unitId
export const badRef: TargetRef = { kind: 'unit' }
