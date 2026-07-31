// Amadeus「打开笔记」的统一门面:搜索/标签/快切/反链等一律走这里,别直接调 loadPage。
// 语义(类 Obsidian):已有认领该笔记的编辑器 tab → 激活它;newTab(⌘点击)→ 新开 tab;
// 一个编辑器都没有(全被关掉)→ 带 notePath 新开;否则在当前(最近活动)编辑器里加载。
import { activePageScope, pageStoreFor, usePageStore } from '@amadeus/store/pageStore'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { amadeus } from '@amadeus/api'
import { askString } from '@amadeus/components/askString'
import { askNewDrawing } from '@amadeus/components/askNewDrawing'
import { BLANK_SCENE_JSON, blankDrawing, isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { DEFAULT_BOARD, writeBoard } from '@amadeus-shared/excalidraw/board'
import { DASH_FM_KEY, isDashboardPath, widgetSource } from '@amadeus-shared/dashboard'
import { COMPILER_VERSION, PAGE_SCHEMA, compile, generateColumnId, generatePageId, generateRowId, type PageManifest } from '@amadeus-shared/compiler'
import { matchFileType } from '@amadeus/plugins/pluginStore'
import { act, actThrottled } from './activity/log'
import { track } from './achievements/store'
import { openLocalHtml } from './builtins'

interface PanelLike { id: string; params?: Record<string, unknown> }

export async function openNote(path: string, opts?: { newTab?: boolean }): Promise<void> {
  // 画板文件绝不进笔记编辑器(compiler 会把插件载荷改写成块 = 在 Obsidian 那边毁档)→ 一律改道白板视图。
  if (isDrawingPath(path)) {
    openDrawing(path)
    return
  }
  // 仪表盘改道网格视图。它**是**一份合法笔记(掉进编辑器也不会坏文件,布局键走 fmExtra 原样保留),
  // 所以这里只是「打开对的那个视图」,不是毁档防线。
  if (isDashboardPath(path)) {
    openDashboard(path)
    return
  }
  // 插件声明的文件类型同理:磁盘是 .md 但绝不进笔记编辑器 → 改道其专属文件类型视图。
  if (matchFileType(path)) {
    openFile(path)
    return
  }
  actThrottled('view.open', { f: path }, `view.open|${path}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const editors = api?.panels.filter((p) => p.params?.__type === 'amadeus-editor') ?? []
  const hit = editors.find((p) => p.params?.notePath === path)
  if (hit) {
    ws.activateLeaf(hit.id) // 激活触发该 leaf 的 activate 效果异步加载
    await waitForActive(path)
    return
  }
  if (opts?.newTab || editors.length === 0) {
    // newTab(⌘点击)显式新开;「一个编辑器都没有」走 openView 默认的就地导航(当前 tab 变编辑器)。
    ws.openView('amadeus-editor', { notePath: path }, 'main', { newTab: opts?.newTab })
    await waitForActive(path)
    return
  }
  // 焦点在非编辑器主 leaf(空白新标签等)→ 先把它就地切成编辑器,笔记才落进「聚焦的 tab」而非旧编辑器。
  // 就地切换时**带上 notePath 即可**:新面板挂载后会自己把它装进自己那份 store(分屏后每个面板一份)。
  // ⚠️ 这里不能再用 usePageStore.getState().loadPage() —— 那解析到「当前活动面板」,而 navigateLeaf
  // 之后 React 还没提交、活动面板仍是旧的,笔记会落到隔壁那半屏去。要装就对着目标面板的 store 装。
  const focused = ws.api ? activeMainPanel(ws.api) : null
  if (focused && ((focused.params ?? {}) as { __type?: string }).__type !== 'amadeus-editor') {
    ws.navigateLeaf(focused.id, 'amadeus-editor', { notePath: path })
    await waitForActive(path)
    return
  }
  await pageStoreFor(focused?.id ?? activePageScope()).getState().loadPage(path)
  await waitForActive(path)
}

/** 打开独立 .db 数据库视图:已有认领该文件的 tab → 激活;否则主区打开(语义同 openNote 的简版)。 */
export function openDb(dbPath: string): void {
  actThrottled('view.open', { f: dbPath }, `view.open|${dbPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-db' && p.params?.dbPath === dbPath)
  if (hit) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-db', { dbPath }, 'main')
}

/** 打开独立 PDF 视图(可批注):已有认领该文件的 tab → 激活(带页号则广播跳页);否则主区打开。page = 1-based。 */
export function openPdf(pdfPath: string, page?: number): void {
  actThrottled('view.open', { f: pdfPath }, `view.open|${pdfPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-pdf' && p.params?.pdfPath === pdfPath)
  if (hit) {
    ws.activateLeaf(hit.id)
    // 已开着 → 广播跳页(PdfAnnotator 听 amadeus:pdf-goto,避免 navigateLeaf remount 重下 PDF)。
    if (page && page >= 1) window.dispatchEvent(new CustomEvent('amadeus:pdf-goto', { detail: { pdfPath, page } }))
    return
  }
  ws.openView('amadeus-pdf', page ? { pdfPath, page } : { pdfPath }, 'main')
}

/** 打开独立图片视图:已有认领该文件的 tab → 激活;否则主区打开(语义同 openPdf 的简版,无批注)。 */
export function openImage(imagePath: string): void {
  actThrottled('view.open', { f: imagePath }, `view.open|${imagePath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-image' && p.params?.imagePath === imagePath)
  if (hit) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-image', { imagePath }, 'main')
}

/** 打开独立白板视图(.excalidraw.md 画布,兼容 Obsidian Excalidraw 插件):已有认领该文件的 tab → 激活;否则主区打开。 */
export function openDrawing(drawingPath: string): void {
  actThrottled('view.open', { f: drawingPath }, `view.open|${drawingPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-drawing' && p.params?.drawingPath === drawingPath)
  if (hit) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-drawing', { drawingPath }, 'main')
}

/** 打开独立仪表盘视图(.dashboard.md 网格):已有认领该文件的 tab → 激活;否则主区打开。
 *  `unlocked` 只在「刚建好」时给 —— 新建完直接能摆,不必先点一下解锁。 */
export function openDashboard(dashPath: string, opts?: { unlocked?: boolean }): void {
  actThrottled('view.open', { f: dashPath }, `view.open|${dashPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-dashboard' && p.params?.dashPath === dashPath)
  if (hit) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-dashboard', opts?.unlocked ? { dashPath, locked: false } : { dashPath }, 'main')
}

/** 新建仪表盘(.dashboard.md),建成即打开(解锁态)。返回 vault 相对路径(取消/失败 null)。
 *  同 createDrawing:出生即命名 + 先挡重名 —— saveAttachment 撞名把 -N 插在最后一个扩展名前,
 *  `x.dashboard.md` 会变成 `x.dashboard-1.md`,复合后缀一破就掉出仪表盘判定、混回普通笔记。 */
export async function createDashboard(parent: string): Promise<string | null> {
  const dir = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = (await askString(dir ? `在「${dir.split('/').pop()}」中新建仪表盘` : '新建仪表盘', '未命名仪表盘'))
    ?.trim().replace(/[\\/]/g, '').replace(/\.dashboard(\.md)?$/i, '')
  if (!name) return null
  const rel = dir ? `${dir}/${name}.dashboard.md` : `${name}.dashboard.md`
  const ps = usePageStore.getState()
  if ([...ps.files, ...ps.pages].some((f) => f.replace(/\\/g, '/') === rel)) {
    window.alert(`「${name}.dashboard.md」已存在`)
    return null
  }
  try {
    const bytes = new TextEncoder().encode(blankDashboard(name))
    // ⚠️ 上面的重名预检读的是缓存清单,与写入不是原子的(并行会话/大小写不敏感文件系统会撞)。
    // 撞名时附件层会把名字改成 `x.dashboard-1.md` —— 复合后缀一破就掉出仪表盘判定,混回普通笔记树。
    // 所以以**返回的真实文件名**为准,后缀不对就说清楚,别拿预算的路径去开视图(Codex 评审)。
    const saved = await amadeus.saveAttachment('', `${name}.dashboard.md`, bytes, { mode: 'vault', folder: dir })
    const actual = dir ? `${dir}/${saved.base}` : saved.base
    if (!isDashboardPath(actual)) {
      window.alert(`新建仪表盘失败:文件名被占用,系统改成了「${saved.base}」(后缀已破)。请换个名字重试。`)
      return null
    }
    act('dashboard.create', { f: actual })
    await usePageStore.getState().refreshStructure()
    openDashboard(actual, { unlocked: true })
    return actual
  } catch (e) {
    window.alert(`新建仪表盘失败:${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** 出厂仪表盘:一个标题块 + 一个时钟 + 一个天气。用 compile() 生成,格式与编辑器保存出来的**逐字节同源**。 */
function blankDashboard(title: string): string {
  const now = new Date().toISOString()
  const ids = ['1', '2', '3']
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } })()
  const manifest: PageManifest = {
    schema: PAGE_SCHEMA,
    id: generatePageId(),
    title,
    createdAt: now,
    updatedAt: now,
    compiler: { version: COMPILER_VERSION },
    root: {
      type: 'stack',
      children: [{ type: 'row', id: generateRowId(), columns: [{ id: generateColumnId(), width: 1, children: ids.map((ref) => ({ ref })) }] }],
    },
    blocks: Object.fromEntries(ids.map((i) => [i, { type: 'markdown' }])),
    fmExtra: [`${DASH_FM_KEY}:`, '  "1": [0, 0, 14, 8]', '  "2": [14, 0, 5, 4]', '  "3": [19, 0, 5, 4]'].join('\n'),
  }
  return compile(manifest, {
    '1': `# ${title}\n\n解锁后可拖动卡片、拖右下角缩放;右上角 ＋ 添加卡片。`,
    '2': widgetSource('clock', { tz }),
    '3': widgetSource('weather', { city: '上海' }),
  })
}

/** 打开一个「插件文件类型」文件到通用 amadeus-plugin-file 视图:已有认领该文件的 tab
 *  → 激活;否则主区打开。新建后打开时该文件可能还没进结构 → 先刷新树再开。非插件文件类型回落系统默认程序。 */
export function openFile(path: string): void {
  // 内置文件类型先接管:插件的 ctx.app.openFile('x.excalidraw.md') 也落在这里,而 matchFileType 已经
  // 拒绝内置后缀(内置优先),不特判的话它会掉到下面的「非插件文件类型 → 交给系统默认程序」。
  if (isDrawingPath(path)) { openDrawing(path); return }
  if (isDashboardPath(path)) { openDashboard(path); return }
  if (/\.db$/i.test(path)) { openDb(path); return }
  if (/\.pdf$/i.test(path)) { openPdf(path); return }
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(path)) { openImage(path); return }
  // 本地库里的 .html → 内置浏览器(云端库没有本机路径 / 内置浏览器关着 → 照旧交系统默认程序)。
  if (/\.html?$/i.test(path)) {
    const ps0 = usePageStore.getState()
    const root = ps0.vaultSide === 'local' ? ps0.vaultRoot : null
    if (root && openLocalHtml(`${root.replace(/\/+$/, '')}/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`)) return
  }
  if (!matchFileType(path)) {
    void amadeus.openVaultFile(path).catch(() => {})
    return
  }
  const ps = usePageStore.getState()
  const norm = path.replace(/\\/g, '/')
  const known =
    ps.files.some((f) => f.replace(/\\/g, '/') === norm) || ps.pages.some((p) => p.replace(/\\/g, '/') === norm)
  const go = (): void => {
    actThrottled('view.open', { f: path }, `view.open|${path}`)
    const ws = useWorkspace.getState()
    const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
    const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-plugin-file' && p.params?.filePath === path)
    if (hit) {
      ws.activateLeaf(hit.id)
      return
    }
    ws.openView('amadeus-plugin-file', { filePath: path }, 'main')
  }
  if (known) go()
  else void ps.refreshStructure().then(go)
}

/** 新建白板(.excalidraw.md),建成即打开;返回 vault 相对路径(取消/失败 null)。
 *  同 newBase:出生即命名 + 先挡重名 —— saveAttachment 撞名把 -N 插在最后一个扩展名前,
 *  `x.excalidraw.md` 会变成 `x.excalidraw-1.md`,后缀一破就掉出白板判定、混回笔记树。 */
export async function createDrawing(parent: string): Promise<string | null> {
  const dir = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  const picked = await askNewDrawing(dir ? `在「${dir.split('/').pop()}」中新建白板` : '新建白板', '未命名白板')
  const name = picked?.name.trim().replace(/[\\/]/g, '').replace(/\.excalidraw(\.md)?$/i, '')
  if (!picked || !name) return null
  const rel = dir ? `${dir}/${name}.excalidraw.md` : `${name}.excalidraw.md`
  if (usePageStore.getState().files.some((f) => f.replace(/\\/g, '/') === rel)) {
    window.alert(`「${name}.excalidraw.md」已存在`)
    return null
  }
  try {
    const src = writeBoard(blankDrawing(BLANK_SCENE_JSON), { ...DEFAULT_BOARD, paper: picked.paper, landscape: picked.landscape })
    const bytes = new TextEncoder().encode(src)
    // 上面的重名预检不是原子的:预检到落盘之间别人可能刚建了同名文件,saveAttachment 就会改名。
    // **一律以它返回的 base 为准** —— 拿预检时的 rel 去开,开的是个不存在的路径。
    const saved = await amadeus.saveAttachment('', `${name}.excalidraw.md`, bytes, { mode: 'vault', folder: dir })
    const final = dir ? `${dir}/${saved.base}` : saved.base
    if (!isDrawingPath(final)) {
      // `-N` 插在最后一个扩展名前 → `x.excalidraw-1.md`,后缀一破就掉出白板判定、混回笔记树。
      window.alert(`已存在同名文件,新建的白板被改名成「${saved.base}」,后缀已破坏。请重命名为 .excalidraw.md 后再打开。`)
      await usePageStore.getState().refreshStructure()
      return null
    }
    track('drawing.create')
    act('drawing.create', { f: final })
    await usePageStore.getState().refreshStructure()
    openDrawing(final)
    return final
  } catch (e) {
    window.alert(`新建白板失败:${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** 打开全文搜索视图(singleton:已开即激活)。 */
export function openSearch(): void {
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-search')
  if (hit) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-search', {}, 'main')
}

/** resolve 时笔记必须真的加载完(调用方靠它定位/高亮块);超时兜底防 leaf 效果没接住。 */
function waitForActive(path: string, timeoutMs = 3000): Promise<void> {
  if (usePageStore.getState().activePage === path) return Promise.resolve()
  return new Promise((resolve) => {
    const off = usePageStore.subscribe((s) => {
      if (s.activePage === path) { clearTimeout(t); off(); resolve() }
    })
    const t = setTimeout(() => { off(); resolve() }, timeoutMs)
  })
}
