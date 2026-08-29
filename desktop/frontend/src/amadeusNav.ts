// Amadeus「打开笔记」的统一门面:搜索/标签/快切/反链等一律走这里,别直接调 loadPage。
// 语义(类 Obsidian):已有认领该笔记的编辑器 tab → 激活它;newTab(⌘点击)→ 新开 tab;
// 一个编辑器都没有(全被关掉)→ 带 notePath 新开;否则在当前(最近活动)编辑器里加载。
import { activePageScope, pageStoreFor, usePageStore } from '@amadeus/store/pageStore'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { amadeus } from '@amadeus/api'
import { hasUnifiedInstance, unifiedHeadings, unifiedRevealBlock, unifiedRevealHeading } from '@amadeus/unified/lifecycle'
import { findHeadingIndex } from '@amadeus-shared/pdfLink'
import { askString } from '@amadeus/components/askString'
import { askNewDrawing } from '@amadeus/components/askNewDrawing'
import { BLANK_SCENE_JSON, blankDrawing, isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { DEFAULT_BOARD, writeBoard } from '@amadeus-shared/excalidraw/board'
import { DASH2_FM_KEY, isDashboardPath, widgetSource } from '@amadeus-shared/dashboard'
import { COMPILER_VERSION, PAGE_SCHEMA, compile, generateColumnId, generatePageId, generateRowId, type PageManifest } from '@amadeus-shared/compiler'
import { matchFileType } from '@amadeus/plugins/pluginStore'
import { extHit } from './viewFileMatch'
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
  // ⚠️ newTab 要**先于**「已开着就激活」判定:⌘/Ctrl 点击的语义是「再开一个标签」,
  //    目标恰好已经开着时如果只是切过去,用户按了修饰键却什么新东西都没得到(Codex 评审实证)。
  if (hit && !opts?.newTab) {
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

/** 打开笔记并滚到标题(聊天里的 `[[笔记#标题]]` 引用条)。匹配规则(含嵌套链的祖先校验)
 *  见 shared 的 findHeadingIndex;找不到就只开笔记不动(与大纲跳转同语义:宁可不动,
 *  不静默跳到别的标题)。就绪竞态:openNote 等到实例挂上,但 doc 可能还空着
 *  (unifiedHeadings 给空)—— 重试几拍再放弃。v3 渲染的笔记没有 unified 实例,同样自然放弃。 */
export async function openNoteAtHeading(path: string, heading: string): Promise<void> {
  await openNote(path)
  for (let tries = 0; tries < 5; tries++) {
    const hs = unifiedHeadings(path)
    if (hs && hs.length) {
      const hit = findHeadingIndex(hs, heading)
      if (hit >= 0) {
        unifiedRevealHeading(path, hit, hs[hit].text)
        // ⚠️ 编辑器刚挂载的头几百毫秒布局未稳:标题列表已齐(doc 解析完)但 PM scrollIntoView
        // 按未测量的坐标算 = 原地不动(e2e 探针实测:立即 reveal 不滚、600ms 后 reveal 正常)。
        // 补一跳:reveal 幂等,已在视口时第二跳视觉上是 no-op。e2e:filecite F7 钉这条。
        // 落点提醒动画只挂在**补跳**这一次:首跳可能压根没滚(布局未稳),那时闪也闪在屏幕外;
        // 两次都闪则是「闪到一半重来」的抖动。代价是反馈晚 600ms,换来必定闪在用户眼前。
        setTimeout(() => unifiedRevealHeading(path, hit, hs[hit].text, true), 600)
      }
      return
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 打开笔记并滚到 Obsidian 块锚 `^abc`(聊天里的 `[[笔记#^abc]]` 引用条)。
 *  语义与 openNoteAtHeading 一字不差(含 600ms 补跳与「找不到就只开笔记不动」),只是定位判据
 *  从「标题文本」换成「块尾部的 `^id` 字面量」。
 *  ⚠️ 只在 v4 渲染的笔记上有效 —— `^id` 是外来格式,来源只有从 Obsidian 导入的素文件,
 *     而素文件恒走 UnifiedPage;v3 老笔记按构造不可能带 `^id`,unifiedRevealBlock 返 false 后
 *     自然停在「只开了笔记」,与本轮之前的行为一致。 */
export async function openNoteAtBlock(path: string, blockId: string): Promise<void> {
  await openNote(path)
  for (let tries = 0; tries < 5; tries++) {
    // 一次调用同时回答「实例挂上了吗」与「这篇里有没有这个块」—— 两种 false 都该再等一拍
    // (编辑器刚挂载时 doc 常常还是空的,与 openNoteAtHeading 轮询 headings 同一个理由)。
    if (unifiedRevealBlock(path, blockId)) {
      // 补跳同标题锚:头几百毫秒布局未稳,立即 reveal 按未测量坐标算 = 原地不动;
      // 落点提醒动画只挂在补跳这一次(首跳可能压根没滚,那时闪也闪在屏幕外)。
      setTimeout(() => unifiedRevealBlock(path, blockId, true), 600)
      return
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 打开独立 .db 数据库视图:已有认领该文件的 tab → 激活;否则主区打开(语义同 openNote 的简版)。 */
export function openDb(dbPath: string, opts?: { newTab?: boolean }): void {
  actThrottled('view.open', { f: dbPath }, `view.open|${dbPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-db' && p.params?.dbPath === dbPath)
  if (hit && !opts?.newTab) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-db', { dbPath }, 'main', opts?.newTab ? { newTab: true } : undefined)
}

/** 打开独立 PDF 视图(可批注):已有认领该文件的 tab → 激活(带页号则广播跳页);否则主区打开。page = 1-based。 */
export function openPdf(pdfPath: string, page?: number, opts?: { newTab?: boolean; quote?: string }): void {
  actThrottled('view.open', { f: pdfPath }, `view.open|${pdfPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-pdf' && p.params?.pdfPath === pdfPath)
  if (hit && !opts?.newTab) {
    ws.activateLeaf(hit.id)
    // 已开着 → 广播跳页(PdfAnnotator 听 amadeus:pdf-goto,避免 navigateLeaf remount 重下 PDF)。
    if (page && page >= 1) window.dispatchEvent(new CustomEvent('amadeus:pdf-goto', { detail: { pdfPath, page, q: opts?.quote } }))
    return
  }
  const params: Record<string, unknown> = { pdfPath }
  if (page) params.page = page
  if (opts?.quote) params.q = opts.quote
  ws.openView('amadeus-pdf', params, 'main', opts?.newTab ? { newTab: true } : undefined)
}

/** 打开独立图片视图:已有认领该文件的 tab → 激活;否则主区打开(语义同 openPdf 的简版,无批注)。 */
export function openImage(imagePath: string, opts?: { newTab?: boolean }): void {
  actThrottled('view.open', { f: imagePath }, `view.open|${imagePath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-image' && p.params?.imagePath === imagePath)
  if (hit && !opts?.newTab) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-image', { imagePath }, 'main', opts?.newTab ? { newTab: true } : undefined)
}

/** 打开独立音视频视图并停在 `loc.at` 秒:已有认领该文件的 tab → 激活 + 广播 `amadeus:media-goto`
 *  就地跳(**绝不 navigateLeaf**:那会 remount 播放器 = 整段视频重新起流);否则主区新开。
 *  ⚠️ 只吃 **vault 相对路径** —— 载体是 `amadeus-asset://`,它只有 `v/<vaultRel>` 一个面。
 *  库外绝对路径的媒体请走 wsFileNav.openWsFile(见 ChatWikiLink 的 openMediaCitation 注释)。 */
export function openMedia(vaultRel: string, loc?: { at: number; to?: number }, opts?: { newTab?: boolean }): void {
  actThrottled('view.open', { f: vaultRel }, `view.open|${vaultRel}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-media' && p.params?.path === vaultRel)
  if (hit && !opts?.newTab) {
    ws.activateLeaf(hit.id)
    if (loc) {
      // 同步派发 + handled 回执(与 pageStore.openWikiLink 同一条通路);这里不看回执 ——
      // 视图刚被激活,里面的 MediaPlayer 必然在场,没人接也只是「没跳」,不该再回落开第二个。
      window.dispatchEvent(new CustomEvent('amadeus:media-goto', { detail: { path: vaultRel, at: loc.at, to: loc.to, handled: false } }))
    }
    // 不带 loc 地激活一个**已开着**的播放器 = 普通打开:两份状态都得清 ——
    //  · params 里的锚(冷挂载真源:不清的话下一次重挂又按上一条引用起播、在旧终点暂停);
    //  · 已挂载播放器里的活体 gotoTo(发一条 `clear` 的 media-goto,它只清暂停点、不动播放位置)。
    // ⚠️ 这条路**够得着**:聊天里的媒体引用条锚点解不开时 loc 就是 null(见 openMediaCitation),
    //    Desk 关着就走到这儿 —— 早先注释写「今天没有这种调用方」是错的(Codex 四审反证)。
    else {
      ws.leafById?.(hit.id)?.setParams({ at: undefined, to: undefined })
      window.dispatchEvent(new CustomEvent('amadeus:media-goto', { detail: { path: vaultRel, clear: true, handled: false } }))
    }
    return
  }
  const params: Record<string, unknown> = { path: vaultRel }
  if (loc) { params.at = loc.at; if (loc.to) params.to = loc.to }
  ws.openView('amadeus-media', params, 'main', opts?.newTab ? { newTab: true } : undefined)
}

/** 打开独立白板视图(.excalidraw.md 画布,兼容 Obsidian Excalidraw 插件):已有认领该文件的 tab → 激活;否则主区打开。 */
export function openDrawing(drawingPath: string, opts?: { newTab?: boolean }): void {
  actThrottled('view.open', { f: drawingPath }, `view.open|${drawingPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => p.params?.__type === 'amadeus-drawing' && p.params?.drawingPath === drawingPath)
  if (hit && !opts?.newTab) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('amadeus-drawing', { drawingPath }, 'main', opts?.newTab ? { newTab: true } : undefined)
}

/** 打开仪表盘视图(.dashboard.md,P3a 起一律画布版 'dashboard';旧网格 view 只为布局恢复保留,
 *  不再从这里开)。已有认领该文件的 tab → 激活;否则主区打开。
 *  `unlocked` 只在「刚建好」时给 —— 新建完直接能摆,不必先点一下解锁。 */
export function openDashboard(dashPath: string, opts?: { unlocked?: boolean; newTab?: boolean }): void {
  actThrottled('view.open', { f: dashPath }, `view.open|${dashPath}`)
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const hit = api?.panels.find((p) => (p.params?.__type === 'dashboard' || p.params?.__type === 'amadeus-dashboard') && p.params?.dashPath === dashPath)
  if (hit && !opts?.newTab) {
    ws.activateLeaf(hit.id)
    return
  }
  ws.openView('dashboard', opts?.unlocked ? { dashPath, locked: false } : { dashPath }, 'main', opts?.newTab ? { newTab: true } : undefined)
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

/** 出厂仪表盘(P3a 起产画布版:布局键 dashboard2:,单位 px)。
 *  一个标题块 + 一个时钟 + 一个天气;compile() 生成,格式与编辑器保存出来的**逐字节同源**。 */
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
    fmExtra: [`${DASH2_FM_KEY}:`, '  "1": [0, 0, 520, 200]', '  "2": [540, 0, 260, 150]', '  "3": [540, 166, 260, 150]'].join('\n'),
  }
  return compile(manifest, {
    '1': `# ${title}\n\n双击卡片进入内容;空白处拖动平移、⌘/Ctrl+滚轮缩放;解锁后可拖动/缩放卡片,右上角 ＋ 添加。`,
    '2': widgetSource('clock', { tz }),
    '3': widgetSource('weather', { city: '上海' }),
  })
}

/** 打开一个「插件文件类型」文件到通用 amadeus-plugin-file 视图:已有认领该文件的 tab
 *  → 激活;否则主区打开。新建后打开时该文件可能还没进结构 → 先刷新树再开。非插件文件类型回落系统默认程序。 */
export function openFile(path: string, opts?: { newTab?: boolean }): void {
  // 内置文件类型先接管:插件的 ctx.app.openFile('x.excalidraw.md') 也落在这里,而 matchFileType 已经
  // 拒绝内置后缀(内置优先),不特判的话它会掉到下面的「非插件文件类型 → 交给系统默认程序」。
  if (isDrawingPath(path)) { openDrawing(path, opts); return }
  if (isDashboardPath(path)) { openDashboard(path, opts); return }
  // 单后缀分派查声明单源表(viewFileMatch;复合后缀在上面两行走 shared 判定函数=毁档防线,次序不动)。
  if (extHit(path, 'amadeus-db')) { openDb(path, opts); return }
  if (extHit(path, 'amadeus-pdf')) { openPdf(path, undefined, opts); return }
  if (extHit(path, 'amadeus-image')) { openImage(path, opts); return }
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
    if (hit && !opts?.newTab) {
      ws.activateLeaf(hit.id)
      return
    }
    ws.openView('amadeus-plugin-file', { filePath: path }, 'main', opts?.newTab ? { newTab: true } : undefined)
  }
  // 先跳转后加载:面板立即开(视图按 filePath 自行拉内容),树刷新在后台补 ——
  // 弱网下不再让 GET /tree 挡住跳转(此前「文件还没进缓存清单」要先等整棵树才开面板)。
  go()
  if (!known) void ps.refreshStructure().catch(() => {})
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

/** resolve 时笔记必须真的加载完(调用方靠它定位/高亮块);超时兜底防 leaf 效果没接住。
 *  v3 的就绪信号 = activePage 落到本路径;**v4 永不设 activePage**,就绪信号换成
 *  「该路径上有活着的 unified 实例」(registerUnifiedPipe 是它挂载后才登记的)。
 *  没有这一路时 v4 的每一次跳转都要空等满 3s 超时才继续。 */
const noteReady = (path: string): boolean =>
  usePageStore.getState().activePage === path || hasUnifiedInstance(path)

function waitForActive(path: string, timeoutMs = 3000): Promise<void> {
  if (noteReady(path)) return Promise.resolve()
  return new Promise((resolve) => {
    // unified 实例的登记不经 store,靠 store 通知轮询它(笔记切换必然带来若干次 store 变更;
    // 真错过了还有 250ms 的兜底轮询,最坏仍受 timeoutMs 封顶)。
    const done = (): boolean => {
      if (!noteReady(path)) return false
      clearTimeout(t)
      clearInterval(poll)
      off()
      resolve()
      return true
    }
    const off = usePageStore.subscribe(() => { done() })
    const poll = setInterval(done, 250)
    const t = setTimeout(() => { clearInterval(poll); off(); resolve() }, timeoutMs)
  })
}
