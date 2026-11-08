/**
 * 浮层落位的防回归闸:自己拿 `innerHeight` 算浮层放哪儿、或者开原生 popover 后自己定位,是「菜单 / 选择器
 * 掉出窗口」反复出现的同一个根(2026-11-08 日历待办的日期与关联笔记弹层:打开后只量一次高度,量到空壳,
 * 从吸底输入框往下开、整个掉出窗口)。落位一律走 `menuAnchor.tsx`:
 *   - 按坐标开(右键、光标)→ `<OverlayAt>` / `useClampedMenu`
 *   - 贴着元素开、浮层不归 React 管(原生 popover、命令式 DOM)→ `followAnchor`
 *   - CSS 已定位只怕横向出界 → `useEdgeNudge`
 * 这些都在内容长高 / 缩放 / 滚动时重算,并保证结果在窗口内。
 *
 * 下面的名单是存量(按文件计 `innerHeight` 与 `showPopover(` 出现次数),**只减不增**:
 * - 新文件出现、或计数变多 → 红。真不是浮层落位(键盘高度、拖出窗口判定…)就把它加进名单并写清理由。
 * - 计数变少 → 也红,把名单里的数改小(闸要收紧,不然腾出来的额度会被下一处手写落位悄悄用掉)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCAN = ['desktop/frontend/src', 'lcl']
const PATTERN = /\binnerHeight\b|\bshowPopover\(/g
const SKIP = new Set(['lcl/engine/menuAnchor.tsx'])

const ALLOW: Record<string, [number, string]> = {
  'lcl/engine/Ribbon.tsx': [6, 'Ribbon 「+N」液滴浮层的落位(363/599/664)与拖出窗口判定(760/775/869)'],
  'lcl/engine/hoverSurface.ts': [2, '悬停浮层:placeHover 自带夹取;另一处是锚点滚出视口就收起'],
  'lcl/engine/FloatingToc.tsx': [2, '悬浮目录的轨道高度按窗口比例,不是锚定浮层'],
  'desktop/frontend/src/amadeus/plugins/chatBoxSurface.tsx': [1, '只用来选 prefer 方向,落位仍走 useClampedMenu'],
  'desktop/frontend/src/amadeus/blocks/markdown/wikiAutocomplete.ts': [1, '补全菜单的下边界取面板或窗口,落位走 clampMenu'],
  'desktop/frontend/src/views/chat2/NormalModeItem.tsx': [1, '二级面板纵向落位走 nestedPanelTop,这里只给边界'],
  'desktop/frontend/src/components/ModelPill.tsx': [1, '二级面板边界,落位走 nestedPanelTop'],
  'desktop/frontend/src/views/chat2/EditorialMessage.tsx': [1, '没有输入框时以窗口底为界,不是浮层'],
  'desktop/frontend/src/amadeus/unified/linkCard.tsx': [1, '链接编辑卡居中在窗口 30% 处,落位走 OverlayAt'],
  'desktop/frontend/src/amadeusViews.tsx': [8, '手机软键盘高度(visualViewport / adjustResize)与共享卡居中'],
  'desktop/frontend/src/views/WorkspaceView.tsx': [1, '手机「更多」菜单的起点,落位走 OverlayAt'],
  'desktop/frontend/src/amadeus/plugins/guideSpotlight.ts': [1, '上手提示圈注的视口尺寸'],
  'desktop/frontend/src/amadeus/plugins/guideTips.ts': [1, '判断锚点是否在视口里'],
  'desktop/frontend/src/amadeus/blocks/excalidraw/ExcalidrawCanvas.tsx': [1, '全屏提示没有锚点时放窗口底部中间'],
  'desktop/frontend/src/amadeus/blocks/markdown/footnote.ts': [1, '判断脚注是否在视口里再决定滚动'],
  'desktop/frontend/src/amadeus/unified/UnifiedPage.tsx': [1, '判断块是否在视口里再决定滚动'],
  'desktop/frontend/src/amadeus/unified/canvasStage.tsx': [1, '画布可见区与视口求交'],
  'desktop/frontend/src/components/ImageViewer.tsx': [1, '判断原图是否在视口里(缩放动画起点)'],
  'desktop/frontend/src/lib/nearViewport.ts': [1, 'IntersectionObserver 的一屏余量'],
  'desktop/frontend/src/sandbox/sandboxWindow.ts': [2, '插件沙箱 inspect:判断 / 滚动元素进视口'],
  'desktop/frontend/src/services/sessionLog.ts': [1, '日志里记视口尺寸'],
  'desktop/frontend/src/smoothCaret.ts': [2, '自绘光标的裁剪框与软键盘判定'],
  'desktop/frontend/src/theme/spaceAmbient.ts': [1, '氛围背景取样区与视口求交'],
  'desktop/frontend/src/views/chat2/deskCapture.ts': [1, '截图区域与视口求交'],
  'desktop/frontend/src/views/coding/StudioGuestSurface.tsx': [1, '嵌入页可见区与其窗口求交'],
  'lcl/engine/WorkspaceHost.tsx': [1, '拖出窗口判定'],
  'lcl/engine/lineSelection.ts': [2, '整行选区高亮的视口框'],
  'lcl/engine/ribbonPointerDrag.ts': [1, '拖动时铺满窗口的遮罩'],
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
}

describe('浮层落位只走 menuAnchor(innerHeight / showPopover 名单只减不增)', () => {
  const files: string[] = []
  for (const d of SCAN) walk(join(ROOT, d), files)
  const counts = new Map<string, number>()
  for (const f of files) {
    const rel = relative(ROOT, f).split('\\').join('/')
    if (SKIP.has(rel)) continue
    const n = readFileSync(f, 'utf8').match(PATTERN)?.length ?? 0
    if (n) counts.set(rel, n)
  }

  it('没有新的手写落位', () => {
    const grown = [...counts].filter(([f, n]) => n > (ALLOW[f]?.[0] ?? 0)).map(([f, n]) => `${f}: ${n}(名单 ${ALLOW[f]?.[0] ?? 0})`)
    expect(grown, '浮层落位请用 lcl/engine/menuAnchor.tsx 的 followAnchor / useClampedMenu / OverlayAt;确实不是浮层落位就加进 ALLOW 并写清理由').toEqual([])
  })
  it('名单是紧的(减少了就把数改小,删光就删行)', () => {
    const slack = Object.entries(ALLOW).filter(([f, [n]]) => (counts.get(f) ?? 0) < n).map(([f, [n]]) => `${f}: ${counts.get(f) ?? 0}(名单 ${n})`)
    expect(slack).toEqual([])
  })
})
