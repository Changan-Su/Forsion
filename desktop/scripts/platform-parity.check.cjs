#!/usr/bin/env node
/**
 * 三端功能同步防线(check:parity)。
 *
 * 为什么需要它:web 与 mobile 都经 vite alias 复用 desktop/frontend/src,但**复用的深度不同**——
 *   - web/src/main.tsx  → `import('@/main')`,整份借走 desktop 的启动 + Root,新功能自动到位;
 *     它唯一的丢功能通道 = bootstrapEngine 里的 host 门控(`window.tangu?.X`)。
 *   - mobile/src/mobileEntry.tsx + MobileRoot.tsx → **各自重写了一份** desktop main.tsx / Root.tsx。
 *     desktop 那两个文件里新加一行,移动端不会自动跟上,也不报错——功能就这么静默消失。
 *     typecheck 抓不到(不是类型错,是「少写了一行」),boot smoke 也抓不到(不崩)。
 *
 * 历史实证:installSmoothCaret 漏装过一轮(用户实报「移动端没生效」);2026-07-30 的
 * applyUiFonts / installScrollFade 落地当天就只进了 desktop。
 *
 * 本脚本做四件事(纯正则,不引 TS parser):
 *   A. 启动序列对齐  desktop/frontend/src/main.tsx  ↔ mobile/src/mobileEntry.tsx
 *   B. 根组件对齐    desktop/frontend/src/Root.tsx  ↔ mobile/src/MobileRoot.tsx
 *   C. 外壳替换边界  lcl/engine/Shell.tsx ↔ (MobileRoot.tsx ∪ SingleColumnHost.tsx)
 *   D. 门控台账      bootstrapEngine.tsx 里的 host 门控名单必须与 KNOWN_GATES 一致
 *
 * C 是 2026-07-30 Codex 评审补的:移动端 vite.config 把 `Shell.tsx` 整个换成空壳,于是 Shell 承载的
 * 东西(命令面板、热键、engine.css)一起消失,而 A/B 两对都看不见这条边界。实证:ribbon 的 `rb-cmd`
 * 无条件注册、经单列壳「⋯」菜单在移动端可点,点完只把 paletteOpen 置 true —— 渲染它的 <CommandPalette/>
 * 随 Shell 一起没了,于是成了静默死按钮,而当时的 A/B 检查全绿。
 *
 * 红灯 = 「desktop 有、移动端没有、也没人声明过这是故意的」。修法二选一:
 *   1) 移动端补上;  2) 加进下面的 SKIP 表并写清理由(理由本身就是文档)。
 *
 * ⚠️ 已知天花板(别把绿灯当「三端已对齐」的证明):判据是**局部标识符名**,不是功能身份。
 *   假阴性:`import * as boot` 后 `boot.run()`、经注册表/回调传递的组件、两侧同名但来自不同模块。
 *   假阳性:两侧用不同 alias 导入同一个东西。
 *   要根治得换成显式 feature-id manifest 或 TS AST 比对 —— 现在没做,因为当前三端都是
 *   「同名静态导入 + 直接调用/直接 JSX」这一种形态,换 AST 的收益还不抵复杂度。形态一变就该换。
 *
 * 用法:cd desktop && npm run check:parity
 */
const fs = require('fs')
const path = require('path')

const GENESIS = path.resolve(__dirname, '../..')
const F = {
  deskBoot: path.join(GENESIS, 'desktop/frontend/src/main.tsx'),
  mobBoot: path.join(GENESIS, 'mobile/src/mobileEntry.tsx'),
  deskRoot: path.join(GENESIS, 'desktop/frontend/src/Root.tsx'),
  mobRoot: path.join(GENESIS, 'mobile/src/MobileRoot.tsx'),
  deskShell: path.join(GENESIS, 'lcl/engine/Shell.tsx'),
  mobShell: path.join(GENESIS, 'lcl/engine/SingleColumnHost.tsx'),
  engine: path.join(GENESIS, 'desktop/frontend/src/bootstrapEngine.tsx'),
}

/** 移动端**故意**不要的东西:名字 → 理由。理由留空 = 视为未声明,照样红灯。 */
const SKIP = {
  // —— 启动序列 ——
  installMultiWindow: '移动端无卫星窗;实现本身对非 electron 天然 no-op',
  windowKind: '多窗分流(?window=detached/mini);移动端只有一个 WebView',
  DetachedRoot: '同上:拖出来的独立窗',
  MiniRoot: '同上:悬浮 mini 卡片',
  ChatPreview: '#preview 设计预览页,截图评审用',
  resolveInitialEffectiveMode: '移动端用 resolveInitialMode(无「跟随系统」的 electron 通道)',
  // —— 根组件 ——
  Root: '移动端的对位物就是 MobileRoot 自己',
  getLanguage: 'soft 主题的 panelGap 只喂给 Dockview Shell;单列壳不消费',
  OnboardingWizard: '引导做的是 setConfig({mode:managed})/providerLogin/envCheck,全是 host 概念;移动端只有云端一条路,登录在挂载前已由 mobileShim 深链完成',
  MarketModal: '入口 rb-market 门控在 window.tangu?.marketList,移动 shim 无此方法 → 该 ribbon 项根本不注册,没有可点入口',
  FeedbackModal: '同上:入口 rb-feedback 门控在 window.tangu?.submitFeedback,移动 shim 无 → 不注册。(组件本身有可选桥检查并显示 unavailable,不会崩;此前这条理由写的「点了就崩」是错的)',
  PluginOnboardingHost: '引导就绪卡只对「刚装好的」插件弹,而装插件是 host 能力(移动端装不了)。注:内建插件(callout/字数统计)在移动端照常启用,但它们不声明 onboarding',
  Shell: '单列壳 SingleColumnHost 取而代之(mobile/vite.config engineSwap)',
  TopBar: 'Dockview tab 栏专属;单列壳自带导航',
  DesktopStatusBar: '单列壳无 footer 槽',
  installStatusBarItems: '同上:没有状态栏就没有状态栏内置项',
  installFileDropGuard: '移动端无 OS 文件拖放',
  HoverTip: '触屏无 hover 态',
  MobilePreviewFrame: '桌面/web 的「手机预览框」;真机走 MobileRoot 不经此处',
  UI_MODE: '预览框判定用,同上',
  PREVIEW_SIZES: '预览框常量',
  // —— 外壳替换边界(Shell.tsx ↔ SingleColumnHost + MobileRoot) ——
  Ribbon: '单列壳用底部导航 + 「⋯」弹层承接 ribbon 项,不渲染竖条 Ribbon 本体',
  WorkspaceHost: 'Dockview 分栏宿主;单列壳自己就是它的对位物',
  installHotkeys: '移动端无物理键盘;命令一律经「⋯」菜单/命令面板点选',
  installSashAffordance: '无分栏缝 = 无缝拖拽提示',
}

/** bootstrapEngine 里已知的 host 门控。新增门控 = 又一条「web/移动端会静默少一块」的通道,必须登记。 */
const KNOWN_GATES = {
  'window.amadeus': 'Amadeus Space 整体;desktop=IPC 桥 / web=云桥 / mobile=Capacitor 桥,三端都有',
  'window.tangu?.backendStatus': '桌面壳语义(含 external 模式)',
  'window.tangu?.mobile': '移动端标志',
  'window.tangu?.spacesList': '用户自定义 Space 读盘 — 仅桌面',
  'window.tangu?.spacesSave': '用户自定义 Space 写盘 — 仅桌面',
  'window.tangu?.marketList': '应用市场 ribbon 图标 — 仅桌面',
  'window.tangu?.submitFeedback': '反馈 ribbon 图标 — 仅桌面',
  'window.tangu?.openMini': 'Mini 卡片命令 — 仅桌面',
}

/**
 * 读源码并剥注释 —— 否则文档注释里提到的名字/门控会被当成真实代码(实测误报过 `window.tangu?.X`)。
 *
 * ⚠️ 只剥**独占整行**的注释,不碰行尾注释。正则不知道自己是否身处字符串/模板串/正则字面量里,
 * 全局剥除会切坏合法代码:`"//cdn.test/x"`、`/[//]/`、`/[/*]/` 都会被吃掉半行乃至跨行吞代码 ——
 * 那是**假阴性**(真调用消失 → 该红没红),比行尾注释造成的假阳性危险得多。
 * 本检查的失败方向必须偏向假阳性:误报只花一条 SKIP 说明,漏报会静默发出一个少功能的移动端版本。
 */
const read = (p) =>
  fs.readFileSync(p, 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '') // 独占行的块注释(JSDoc 文件头等)
    .replace(/^[ \t]*\/\/.*$/gm, '')                 // 独占行的行注释

/** 取本地模块 import 进来的标识符(含 `X as Y` 的 Y、默认导入),排除 type-only import。 */
function importedNames(src) {
  const out = new Set()
  const re = /import\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const [, clause, mod] = m
    if (!/^[.@]/.test(mod)) continue // 只看本地/别名模块,忽略 react/framer-motion 等
    for (const raw of clause.replace(/[{}]/g, ',').split(',')) {
      const s = raw.trim()
      if (!s || s.startsWith('type ')) continue
      const name = (s.includes(' as ') ? s.split(' as ').pop() : s).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  return out
}

/** 这些 import 里,哪些在正文中真的被「用起来」了(调用 `x(` 或渲染 `<X`)。 */
function usedNames(src, names) {
  const body = src.replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '') // 去掉 import 段自身
  const out = new Set()
  for (const n of names) {
    const call = new RegExp(`\\b${n}\\s*\\(`)
    const jsx = new RegExp(`<${n}[\\s/>]`)
    if (call.test(body) || jsx.test(body)) out.add(n)
  }
  return out
}

/** mobFiles 可给多份:移动端一件事拆到两个文件时(如 Shell 的活由 MobileRoot + SingleColumnHost 分担),
 *  取并集才是它真正的对位面。 */
function diff(deskFile, mobFiles, label, problems) {
  const dSrc = read(deskFile)
  const desk = usedNames(dSrc, importedNames(dSrc))
  const mob = new Set()
  for (const f of mobFiles) {
    const s = read(f)
    for (const n of usedNames(s, importedNames(s))) mob.add(n)
  }
  const missing = [...desk].filter((n) => !mob.has(n) && !SKIP[n]).sort()
  if (missing.length) problems.push({ label, deskFile, mobFile: mobFiles.join(' + '), missing })
  return { deskCount: desk.size, mobCount: mob.size, desk, missing }
}

function checkGates(problems) {
  const src = read(F.engine)
  const found = new Set()
  for (const m of src.matchAll(/window\.tangu\?\.[A-Za-z_$][\w$]*|window\.amadeus(?![\w$])/g)) found.add(m[0])
  const undeclared = [...found].filter((g) => !(g in KNOWN_GATES)).sort()
  if (undeclared.length) problems.push({ label: 'D. host 门控台账', deskFile: F.engine, mobFile: null, missing: undeclared })
  const stale = Object.keys(KNOWN_GATES).filter((g) => !found.has(g)).sort()
  return { found, undeclared, stale }
}

// —— 跑 ——
const problems = []
const a = diff(F.deskBoot, [F.mobBoot], 'A. 启动序列(main.tsx ↔ mobileEntry.tsx)', problems)
const b = diff(F.deskRoot, [F.mobRoot], 'B. 根组件(Root.tsx ↔ MobileRoot.tsx)', problems)
const c = diff(F.deskShell, [F.mobRoot, F.mobShell], 'C. 外壳替换边界(Shell.tsx ↔ MobileRoot + SingleColumnHost)', problems)
const d = checkGates(problems)

// 自检:正则解析一旦失效(重构成 export default、换导入写法、改成 `import * as x` 成员调用…),
// 两边都会解析成空集 → 静默全绿,这是本脚本最危险的失败模式。
// 只看数量不够(留十个普通调用、把关键启动逻辑搬进 namespace 成员调用即可蒙混,codex 评审指出),
// 所以同时钉几个**具名锚点**:这些名字在各自文件里必然存在,抽不到就等于解析器已经瞎了。
const ANCHORS = [
  [a, 'installEngine', 'desktop main.tsx'],
  [b, 'SettingsModal', 'desktop Root.tsx'],
  [c, 'CommandPalette', 'lcl Shell.tsx'],
]
const blind = ANCHORS.filter(([r, name]) => !r.desk.has(name)).map(([, name, where]) => `${name}(${where})`)
if (blind.length || a.deskCount < 10 || b.deskCount < 10 || d.found.size < 5) {
  console.error('❌ 解析失效:正则与源码结构已脱节 —— 先修本脚本,别当绿灯。')
  if (blind.length) console.error(`   抽不到的具名锚点:${blind.join(', ')}`)
  console.error(`   boot=${a.deskCount} root=${b.deskCount} shell=${c.deskCount} gates=${d.found.size}`)
  process.exit(2)
}

const rel = (p) => path.relative(GENESIS, p)
console.log('=== 三端功能同步检查 (check:parity) ===')
console.log(`A. 启动序列  desktop ${a.deskCount} 项 / mobile ${a.mobCount} 项`)
console.log(`B. 根组件    desktop ${b.deskCount} 项 / mobile ${b.mobCount} 项`)
console.log(`C. 外壳边界  desktop ${c.deskCount} 项 / mobile ${c.mobCount} 项`)
console.log(`D. host 门控 ${d.found.size} 处,已登记 ${Object.keys(KNOWN_GATES).length} 条`)
if (d.stale.length) console.log(`   ⚠ KNOWN_GATES 里有 ${d.stale.length} 条已在代码中消失(可删):${d.stale.join(', ')}`)

if (!problems.length) {
  console.log('\n✅ 通过:desktop 的每一项在移动端要么有、要么已声明为故意不要。')
  process.exit(0)
}

console.log('')
for (const p of problems) {
  console.log(`❌ ${p.label}`)
  console.log(`   ${rel(p.deskFile)}${p.mobFile ? ` → ${rel(p.mobFile)}` : ''}`)
  for (const n of p.missing) console.log(`     · ${n}`)
  console.log('')
}
console.log('修法二选一:')
console.log('  1) 在移动端补上(mobileEntry.tsx / MobileRoot.tsx),或在 bootstrapEngine 里登记门控;')
console.log('  2) 确认是故意不要 → 加进 scripts/platform-parity.check.cjs 的 SKIP / KNOWN_GATES,并写清理由。')
console.log('\n可直接粘贴的骨架:')
for (const p of problems) {
  const target = p.label.startsWith('D') ? 'KNOWN_GATES' : 'SKIP'
  for (const n of p.missing) console.log(`  ${target}: ${JSON.stringify(n)}: '',   // ← 填理由`)
}
process.exit(1)
