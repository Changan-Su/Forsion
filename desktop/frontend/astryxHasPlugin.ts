/** astryx(StyleX 预编译 CSS)里 `stylex.when.ancestor(':has(…)')` 生成的 `.x.x:where(.marker:has(…) *)`,
 *  构建时改写成「祖先上用 :has 写一个继承变量,自己用 @container style() 读」(2026-10-16,同 theme/calm.css 的 Ribbon 那条)。
 *  原形状 :has 不在最后一段、结尾是 `*`:Blink 把这类规则的结尾并进一份失效清单,页面上**任何**一次插入都按整棵子树重算 ——
 *  6 条(CheckboxInput / Switch 焦点环、Layout 头尾无分隔线时收内边距)各自就让 60 条消息的对话每插入一次多 15–25ms。
 *  语义不变:「任一祖先 marker 满足」= 变量往下继承;特异性不变(:where 本就算 0)。原理见 src/cssHasGuard.test.ts 文件头;
 *  仪器:scripts/insert-restyle.probe.cjs(真 Electron 插入代价)、scripts/astryx-has.check.cjs(原 / 改写逐项比计算样式)。 */
const ID = '/@astryxdesign/core/dist/astryx.css'
const RULE = /(?<=^|[\s{}])(\.[\w-]+(?:\.[\w-]+)*):where\((\.[\w-]+:has\((?:[^()]|\([^()]*\))*\)) \*\)((?::not\(#\\#\))*)\{([^{}]*)\}/g

export function rewriteAstryxHas(css: string): string {
  const vars = new Map<string, string>()
  const out = css.replace(RULE, (_, subject: string, anchor: string, bump: string, body: string) => {
    const v = vars.get(anchor) ?? `--astryx-has-${vars.size}`
    vars.set(anchor, v)
    return `${anchor}{${v}:1}@container style(${v}: 1){${subject}${bump}{${body}}}`
  })
  // 升级 astryx 换了形状(没被上面改到)就让构建红,别悄悄把整页重算带回来。
  if (/:where\([^{}]*:has\(/.test(out)) throw new Error('[astryxHasPlugin] astryx.css has an ancestor-:has rule this rewrite does not cover; see frontend/astryxHasPlugin.ts')
  return out
}

export function astryxHasFix() {
  return {
    name: 'forsion-astryx-has',
    enforce: 'pre' as const,
    transform(code: string, id: string) { return id.split('?')[0].endsWith(ID) ? rewriteAstryxHas(code) : undefined },
  }
}
