/**
 * 端判定**单源**(方案 D6):desktop / web / mobile。
 *
 * 2026-09-28 从 agentRunService.ts 原样搬来(那边 re-export,既有 import 不变):引擎目标解析层
 * (services/engine/targets.ts)也要按端推 home 目标的来路,而 agentRunService 反过来要 import
 * 解析层 —— 放在叶子模块里就没有循环依赖,也不会因为测试把 agentRunService 整个 mock 成 `{}` 而连坐。
 *
 * 每次调用现算:共享模块可能比 web/mobile shim 更早求值,提到模块级常量会把之后所有判定永久冻成
 * desktop;别处不许再写第二份 `window.tangu?.X` 端判定,也不许拿 currentClientId().split('/')[0] 绕。
 * 本文件在 platform-parity 的 GATE_FILES 台账里。
 */
export type ClientPlatform = 'desktop' | 'web' | 'mobile'

export function currentPlatform(): ClientPlatform {
  return typeof window === 'undefined' ? 'desktop' // node 环境(vitest)兜底,浏览器里恒有 window
    : window.tangu?.mobile ? 'mobile'
    : window.tangu?.cloudWeb ? 'web'
    : 'desktop'
}
