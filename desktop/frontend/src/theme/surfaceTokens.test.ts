/**
 * 浮层表面 token 的静态围栏(DESIGN §3「浮层表面」)。
 *
 * 菜单、弹层、弹窗、toast 的底色 / 模糊 / 描边一律读 --surface-menu / --surface-float / --surface-blur / --surface-edge,
 * 没定义时回落各自原来的实色;Glass 这类材质主题只改这几个 token。11-08 检修之前 Glass 是逐个列类名接管浮层的,
 * 10 月以后新加的十几个浮层(.lcl-hovercard、.t2-bgpop、.lcl-ftoc-panel……)都没进名单,在 Glass 下是实色,
 * 运行时检查(check:chatside 25)用的是同一张名单,于是一直是绿的。
 *
 * 这里扫所有非主题 CSS:**「浮着」(z-index 走 --z-* 档位,或 fixed / absolute 定位 + 卡片阴影)且自己画了底色**的规则,
 * 必须读 --surface-menu / --surface-float,或者进下面的实色白名单并写明理由。新浮层红了:先改成读 token;
 * 确实该是实色(画布内容、要和动画同色、自带材质)才进白名单。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = join(__dirname, '../../../..')
const ROOTS = [join(REPO, 'desktop/frontend/src'), join(REPO, 'lcl')]

/** 刻意不读表面 token 的浮层,按理由分组。值 = 所在文件(相对仓库根),防止白名单里留着已经删掉的类。 */
const SOLID_BY_DESIGN: Record<string, { file: string; why: string }> = {
  // 画布 / 内容本身:它们是正文的一部分,不是压在正文上的面
  '.iv-img': { file: 'desktop/frontend/src/components/imageViewer.css', why: '看图器里的图片本身' },
  '.img-stack-card': { file: 'desktop/frontend/src/views/chat2/chat2.css', why: '对话里的图片叠卡' },
  '.img-stack-nav': { file: 'desktop/frontend/src/views/chat2/chat2.css', why: '图片叠卡的翻页钮,压在图上' },
  '.t2cv-read': { file: 'desktop/frontend/src/views/chat2/chat2.css', why: '画布视图的阅读卡(正文)' },
  '.t2cv-read-ghost': { file: 'desktop/frontend/src/views/chat2/chat2.css', why: '阅读卡拖动时的替身' },
  '.hp-lib-ghost': { file: 'desktop/frontend/src/views/homepage.css', why: '从收纳盒拖小组件时跟手的替身卡,和主页上的卡同色' },
  '.t2cv-empty': { file: 'desktop/frontend/src/views/chat2/chat2.css', why: '画布视图空态' },
  '.dash2-board': { file: 'desktop/frontend/src/views/dashCanvas.css', why: 'Dashboard 画板本身' },
  '.amx-ucard': { file: 'desktop/frontend/src/amadeus/styles.css', why: '正文里的卡' },
  '.amx-linkcard': { file: 'desktop/frontend/src/amadeus/styles.css', why: '正文里的链接卡' },
  '.startup-appearance-preview': { file: 'desktop/frontend/src/components/startupAppearance.css', why: '外观预览缩略图' },
  '.appearance-import': { file: 'desktop/frontend/src/components/startupAppearance.css', why: '外观导入卡,在设置纸面上' },
  '.mp-panel': { file: 'desktop/frontend/src/styles/motionTheme.css', why: '动效主题的预览模型,不是真浮层' },
  // 要和动画 / 液滴同色
  '.mini-card-popover': { file: 'lcl/engine/miniCard.css', why: '开合走液滴,真面板接手时必须与液滴同色(11-05)' },
  '.mini-card-notice': { file: 'lcl/engine/miniCard.css', why: 'Mini 卡片里的提示条,同上' },
  '.ach-toast-body': { file: 'desktop/frontend/src/achievements/achievements.css', why: 'clip-path 揭示动画,半透会在揭示边缘露底' },
  '.ach-toast-badge': { file: 'desktop/frontend/src/achievements/achievements.css', why: '成就勋章本身' },
  // 自带材质或由主题按结构另画
  '.vc-bar': { file: 'desktop/frontend/src/mini/voiceCall.css', why: '通话条自带 74% + 模糊,并已处理关毛玻璃' },
  '.rb-peek': { file: 'lcl/engine/engine.css', why: '卡里是活的 View,材质由主题画在 ::before 上' },
  // 白板 / 工作室 / PDF 舞台上的浮标:压在画布或图片上,另一套 HUD 材质
  '.amx-gridpop': { file: 'desktop/frontend/src/amadeus/blocks/excalidraw/viewIsland.css', why: '白板岛屿,跟白板自己的岛屿色' },
  '.amx-fullhint': { file: 'desktop/frontend/src/amadeus/blocks/excalidraw/viewIsland.css', why: '白板全屏提示' },
  '.amx-stage-hud': { file: 'desktop/frontend/src/views/imageStudio/imageStudio.css', why: '图像工作室舞台浮标' },
  '.amx-stage-minimap': { file: 'desktop/frontend/src/views/imageStudio/imageStudio.css', why: '图像工作室小地图' },
  '.ims-create-tools': { file: 'desktop/frontend/src/views/imageStudio/imageStudio.css', why: '图像工作室工具条' },
  '.ims-progress': { file: 'desktop/frontend/src/views/imageStudio/imageStudio.css', why: '图像工作室进度' },
  '.csp-loading': { file: 'desktop/frontend/src/views/coding/studio.css', why: '编码工作室舞台加载态' },
  '.csp-inspect-hint': { file: 'desktop/frontend/src/views/coding/studio.css', why: '编码工作室检查提示' },
  '.pdfa-bottombar': { file: 'desktop/frontend/src/amadeus/pdf/pdfAnnotator.css', why: 'PDF 标注底栏,压在页面图上' },
  '.guide-tip-line': { file: 'desktop/frontend/src/amadeus/plugins/guideSpotlight.css', why: '圈注线,不是面' },
  '.quota-harness-toast': { file: 'desktop/frontend/src/quotaHarness.css', why: '仪器页' },
  // 11-08 检修时已有、这轮没审的(保持原样,改到它们时顺手判一下)
  '.chat-pick-held': { file: 'desktop/frontend/src/components/compactChatPicker.css', why: '未审' },
  '.pl-fab': { file: 'desktop/frontend/src/components/phoneList.css', why: '手机列表的悬浮钮,未审' },
  '.sync-setup-progress': { file: 'desktop/frontend/src/components/syncSetup.css', why: '未审' },
  '.ob-drawer': { file: 'desktop/frontend/src/styles/base.css', why: '未审' },
  '.nc-plate': { file: 'lcl/engine/singleColumn.css', why: '未审' },
}

/** 启发式扫不到的浮层(自己不定位、由 fixed 外壳承载,或 z 写在别处),逐个点名:它们必须一直读表面 token。
 *  任何一个退回实色 / --bg-glass,这里就红 —— 光靠「浮着又画了底色」的启发式,它们掉出 token 时没人知道(Codex 评审 11-08)。 */
const MUST_READ_TOKENS = [
  '.modal', '.memv-modal-box', '.cmd-panel', '.am-app .cmd-panel', '.amx-qf', '.amx-qf-card', '.amxc-panel', '.amxc-card', '.csx-pub-card',
  '.ntf', '.ntf-more', '.wsfile-panel', '.amx-trash-pop', '.amx-hoverprev', '.amx-toast', '.amx-findbar', '.ui-zoom-hud',
  '.jump-bottom', '.voting-indicator', '.ui-popover', '.ctx-menu', '.am-app .ctx-menu', '.composer-menu', '.cm-sub', '.account-pop',
]

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'themes' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) cssFiles(p, out)
    else if (name.endsWith('.css')) out.push(p)
  }
  return out
}

/** 一条规则 × 它选择器列表里的一项。逐条判,不按末级类名合并:否则 `.ctx-menu` 读了 token,
 *  更具体的 `.am-app .ctx-menu` 写回实色也会被前者「代为通过」(Codex 评审 11-08)。 */
interface Rule { selector: string; cls: string; file: string; floating: boolean; painted: boolean; tokens: boolean; glassy: boolean }

function rules(): Rule[] {
  const out: Rule[] = []
  for (const file of ROOTS.flatMap((r) => cssFiles(r))) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      const floating = /z-index:\s*var\(--z-/.test(body)
        || (/position:\s*(fixed|absolute)/.test(body) && /box-shadow:\s*var\(--card-shadow/.test(body)) // shadow-contract: effect (test regex, not a style)
      const painted = /background(-color)?:\s*(var\(--(bg-card|bg|sidebar-bg|surface-2|bg-glass|bg-elevated)\b|color-mix)/.test(body)
        || /box-shadow:\s*var\(--card-shadow/.test(body) // shadow-contract: effect (test regex, not a style)
      const tokens = /background(-color)?:\s*var\(--surface-(menu|float)\b/.test(body)
      const glassy = /var\(--(bg-glass|panel-blur)\b/.test(body)
      for (const part of m[1].split(',')) {
        const selector = part.trim().replace(/\s+/g, ' ')
        const cls = (selector.match(/\.[a-zA-Z][\w-]*/g) || []).pop()
        if (cls) out.push({ selector, cls, file: relative(REPO, file), floating, painted, tokens, glassy })
      }
    }
  }
  return out
}

describe('浮层表面 token', () => {
  const all = rules()
  const flagged = all.filter((r) => r.floating && r.painted)

  it('扫得到浮层(防止扫描规则失效后整条测试空转)', () => {
    expect(all.filter((r) => r.tokens).length).toBeGreaterThanOrEqual(40)
  })

  it('浮着又画了底色的规则逐条都读 --surface-*,或在实色白名单里写明理由', () => {
    const bad = flagged.filter((r) => !r.tokens && !SOLID_BY_DESIGN[r.cls]).map((r) => `${r.selector}  ${r.file}`)
    expect(bad, '新浮层请改读 var(--surface-menu, …) / var(--surface-float, …);确该实色的进 SOLID_BY_DESIGN 并写理由').toEqual([])
  })

  it('点名的浮层(启发式扫不到的那些)都还读 --surface-*', () => {
    const missing = MUST_READ_TOKENS.filter((sel) => !all.some((r) => r.selector === sel && r.tokens))
    expect(missing, '这些浮层不再读表面 token 了:Glass 下会变回实色,Genesis 下可能又半透').toEqual([])
  })

  it('白名单里没有已经删掉或已改读 token 的类', () => {
    const stale = Object.entries(SOLID_BY_DESIGN)
      .filter(([cls, v]) => !flagged.some((r) => r.cls === cls && r.file === v.file && !r.tokens))
      .map(([cls, v]) => `${cls}  ${v.file}`)
    expect(stale).toEqual([])
  })

  it('浮层底色不用 --bg-glass / --panel-blur(Genesis 的 --panel-blur 是 none,九成不透明的 --bg-glass 就成了半透又不糊)', () => {
    const offenders = all.filter((r) => r.glassy && (r.tokens || MUST_READ_TOKENS.includes(r.selector) || (r.floating && r.painted)))
      .map((r) => `${r.selector}  ${r.file}`)
    expect(offenders).toEqual([])
  })
})
