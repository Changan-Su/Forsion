/** unified 实例的生命周期登记处(Codex 评审 P0,2026-08-13):
 *  UnifiedPage 的写盘管线是组件私有的,pageStore 的三道全局防线(flushAllScopes 换库前落盘 /
 *  删除清 saveTimer / remapScopePaths 改名跟队)全都看不见它 —— 换库时防抖写把旧库内容写进新库、
 *  删除/改名/移动后防抖写复活旧文件,全是这一个盲区。本模块是唯一登记点:
 *  - flushUnifiedScopes():换库/全局落盘前,所有 unified 实例待写先落地(pageStore.flushAllScopes 调)。
 *  - retireUnifiedPath(path):该路径(或其子树)的 unified 实例全部退休 —— 此后任何写盘一律跳过。
 *    删除/改名/移动的发起方在动文件**之前**调它。
 *  零依赖(被 pageStore 反向 import,不许在这里 import pageStore/UnifiedPage,否则模块环)。 */

export interface UnifiedPipeHandle {
  path: string
  /** strict=true must reject write failures and drain all pending edits before retiring. */
  flush: (strict?: boolean) => Promise<void>
  /** 停写。movedTo = 这篇是被**挪走 / 改名**到了那里(删除 / 切号时不给):实例据此把还没落盘的字存成新路径的草稿
   *  (评审 G2-03),新路径的实例挂载时出「恢复草稿」条 —— 退休不许把它们静默丢掉。 */
  retire: (movedTo?: string) => void
  /** OS 拖入/上传按钮的文件走这里进 unified(存附件 + 光标处插 `![[base]]`);可选。
   *  false = 本实例不接(只读 / 已退休 / 编辑器不在),路由接着问下一个同路径实例。 */
  insertFiles?: (files: File[]) => boolean | void
  /** 当前正文(**不重新与编辑器同步**:上次保存那一刻的快照,≤800ms 陈旧,与只读面板的刷新
   *  节拍一致)。字数统计等只读面板用 —— v4 正文不进 pageStore,读 blocks 只会得空。 */
  bodyNow?: () => string
  /** 大纲:从 PM doc 现取标题(与渲染同源)。 */
  headings?: () => Array<{ level: number; text: string; pos: number }>
  /** 字 / 词 / 选区计数(C-22):按可见文字现数;编辑器不在(源码模式)→ null,调用方回落 bodyNow。 */
  statsNow?: () => import('./noteStats').NoteStats | null
  /** 大纲跳转:把第 index 个标题滚进视野。⚠️ 这是**另一次**遍历(点击发生在渲染之后,期间文档
   *  可能已增删标题),故必须带上记录时的 text 复核:对不上就按文本找,再找不到就不跳 ——
   *  宁可不动,也不要静默跳到另一个标题上(Codex 评审 medium)。 */
  revealHeading?: (index: number, text: string, flash?: boolean) => void
  /** 块锚跳转:把尾部挂着 `^<id>` 的那个块滚进视野。**找不到返回 false**(调用方据此重试/放弃,
   *  同标题锚:宁可不动,绝不静默跳到别处)。`^id` 是 Obsidian 互操作格式,详见 pdfLink.ts。 */
  revealBlock?: (id: string, flash?: boolean) => boolean
  /** 全文命中跳转(评审 G4-01:全智库搜索 / 标签面板点命中):按文档序找第一处命中(needles 依次尝试,整串优先),
   *  命中藏在会话折叠(标题小节 / 列表子项)里先展开,再选中命中文字并亮到阅读位置。找不到返回 false(同块锚)。
   *  tag=true:needle 是 `#标签`,按标签边界匹配(`#work` 不落在 `#workshop` 上)。 */
  revealText?: (needles: string[], opts?: { tag?: boolean; flash?: boolean }) => boolean
  /** 让正文拿焦点、**不动选区**(评审 G4-06:从快速查找 / 日记进入已有笔记后直接打字)。编辑器还没建好 → false
   *  (调用方重试);只读 / 已退休 → true(没什么可做,别让调用方空转)。 */
  focusBody?: () => boolean
  /** 外来 frontmatter 原文(插件的每页数据存这儿)。v3 那份在 manifest.fmExtra,v4 在 pipe.fm 里。
   *  **只读**:写口本轮不做(不带 bind 的块表面上零消费者,且 v4 fm 写要与结构键派生同场竞技,
   *  见 docs/ToBeImproved/块表面v4适配方案_2026-08-20.md §6.3)。 */
  fmNow?: () => string
  /** 往本篇插一段 markdown(块表面写口的 v4 后端)。落点见 UnifiedPage 的 insertMd:
   *  'cursor' = 光标所在**顶层块**之后(该块为空则原地替换)、'start' = 文首、'end' = 文末。
   *  实例退休(改名/删除/移动之后)一律 false —— 往幽灵路径写字比不写更糟。 */
  insertMarkdown?: (md: string, where: 'cursor' | 'start' | 'end') => boolean
  /** frontmatter 补丁的实例写口(评审 G1-05):笔记视图 / 日历 / 图标 / `.fd` children 这类「改一个 fm 键」的写,
   *  笔记开着时交给实例自己改 pipe.fm、走它的单写者写盘管线 —— 外科写会被实例下一次击键用旧 fm 整篇写回。
   *  返回这次写盘的 Promise = 已接手(fm 读不懂时 fail-closed 什么都不写也算接手,不许退回外科写绕过它);
   *  null = 本实例不接(只读 / 已退休 / 已卸载),调用方照旧外科写。补丁语义同 setFmExtraOnSource(undefined = 删键)。
   *  follow=true(评审 G1-02 返修):同篇另一个实例在写这笔,本实例只把补丁并进自己的 pipe.fm、**不写盘** ——
   *  否则它手里的旧 fm 会在下一次保存时把新属性整篇写回去;这份 fm 也不算它自己的改动(见 UnifiedPage 的 peerFm)。 */
  patchFm?: (patch: Record<string, unknown>, follow?: boolean) => Promise<void> | null
  /** 手里有没有还没落盘的用户改动。同篇多开打 fm 补丁时由它负责写盘:它的全文(新 fm + 自己的字)是超集。 */
  dirty?: () => boolean
  /** 登记者身份(实例私有的任意对象):announceUnifiedWrite 靠它把发起者自己排除在外。 */
  owner?: object
  /** 所属 leaf(PageScopeCtx 的值;不在任何面板里 = null)。openNote 据此把「已开着这篇」落到最近用过的那个标签。 */
  scope?: string | null
  /** 最近一次被用户用到的时刻(焦点 / 指针进入本实例,或所属 leaf 成为活动面板);0 = 从未。
   *  同篇多开时按路径的操作(插模板 / 大纲 / 跳转 / 拖入 / fm 补丁)都落到它最大的那个(评审 G1-02)。 */
  lastActive?: () => number
  /** 同窗同路径的**另一个**实例刚把这篇写盘成功(G1-01):盘上已是它的新版,本实例去回灌
   *  (与外部改动同一条回灌路径:等打字静默、有未落盘编辑则按冲突策略处理)。 */
  peerWrote?: () => void
  /** 助手回答插回笔记(评审 G3-08):与 insertMarkdown 同一条解析 + 事务,但**不抢焦点**、单独一步撤销;
   *  anchor 解析得到 → 落在被引用块之后,否则光标所在顶层块之后(正文从没被聚焦过 → 文末)。
   *  只读 / 锁定实例不登记它;已退休 / 源码模式 → null(不接)。返回的 undo 只在文档仍是插入后那一版时撤回。 */
  insertReply?: (md: string, anchor?: ReplyAnchor | null) => { undo: () => boolean } | null
}

/** 「问 Tangu」引用里带回来的出处(G3-08):标题锚 `[[路径#标题]]` 的标题 + 被引用的原文。 */
export interface ReplyAnchor {
  heading?: string
  text?: string
}

const handles = new Set<UnifiedPipeHandle>()

// 实例集合的版本号:只读面板(大纲/字数)靠它知道「实例挂上来了/走了」。登记发生在 effect 里,
// 比面板首渲染晚 —— 没有这一声,打开 v4 笔记时大纲会一直停在「没有标题」直到下一次保存。
let gen = 0
const genListeners = new Set<() => void>()
function bumpGen(): void {
  gen++
  for (const f of genListeners) f()
}
export function unifiedGen(): number {
  return gen
}
export function subscribeUnified(f: () => void): () => void {
  genListeners.add(f)
  return () => genListeners.delete(f)
}

export function registerUnifiedPipe(h: UnifiedPipeHandle): () => void {
  handles.add(h)
  bumpGen()
  return () => {
    handles.delete(h)
    bumpGen()
  }
}

/** path 上的实例,**最近用过的在前**(评审 G1-02)。此前一律 `for…of handles` 取第一个登记的:同篇双开时在 B 里
 *  插模板,内容进了 A、焦点被抢到 A;大纲给的是 A 的标题;拖进 B 的文件插进 A、紧接着被 B 的写入盖掉。
 *  Obsidian 的命令都作用于当前活动的 leaf —— 这里的「活动」由实例自己报(lastActive),同分(都没被用过)按登记序。 */
function byRecency(path?: string): UnifiedPipeHandle[] {
  const hit: Array<{ h: UnifiedPipeHandle; at: number; i: number }> = []
  let i = 0
  for (const h of handles) if (path == null || h.path === path) hit.push({ h, at: h.lastActive?.() ?? 0, i: i++ })
  return hit.sort((a, b) => b.at - a.at || a.i - b.i).map((x) => x.h)
}

/** path 上最近用过的那个实例所属的 leaf(没有实例 / 实例不在面板里 = null)。openNote 用它挑「已开着这篇」的标签。 */
export function unifiedScopeFor(path: string): string | null {
  return byRecency(path)[0]?.scope ?? null
}

/** 同篇多开(双标签 / 分屏 / Mini)的同窗通知(评审 G1-01):owner 刚把 path 写盘成功 → 其余同路径实例去回灌。
 *  跨窗那半由主进程负责(writeTextFile 成功后给**发起窗口以外**的窗口发 externalChange);同窗的实例共用一个
 *  渲染进程,主进程分不出来,只能在这里点名。不通知 = 另一个实例停在旧全文,下一次保存把这次写的整篇盖掉。 */
export function announceUnifiedWrite(path: string, owner: object): void {
  for (const h of [...handles]) if (h.path === path && h.owner !== owner) h.peerWrote?.()
}

/** 往 path 上开着的 v4 实例打 frontmatter 补丁(评审 G1-05)。有实例接手 → 返回那发写盘的 Promise;
 *  没有(没开 / 只读 / 已退休)→ null,调用方照旧外科写(setPageFrontmatter)。
 *  同篇多开(评审 G1-02 返修):补丁并进**每一个**同路径实例,由一个实例写 —— 手里有未落盘改动的优先(它的全文
 *  是超集;交给干净的那个写,脏的那个随后按冲突策略出一份多余的冲突副本),其次最近用过的。其余实例只并不写
 *  (follow),写者落盘后经 announceUnifiedWrite 回灌对齐。此前只交给第一个登记的:另一个有待存正文时,它下一次
 *  保存用旧 fm 整篇写回,新属性就没了。 */
export function unifiedPatchFm(path: string, patch: Record<string, unknown>): Promise<void> | null {
  const hs = byRecency(path).filter((h) => h.patchFm)
  hs.sort((a, b) => Number(!!b.dirty?.()) - Number(!!a.dirty?.())) // 稳定排序:脏的在前,同档仍按最近用过
  let done: Promise<void> | null = null
  const followers: UnifiedPipeHandle[] = []
  for (const h of hs) {
    if (done) followers.push(h)
    else done = h.patchFm!(patch)
  }
  if (done) for (const h of followers) h.patchFm!(patch, true)
  return done
}

/** 全部 unified 实例待写落盘(单实例失败不拖累别家)。 */
export async function flushUnifiedScopes(strict = false): Promise<void> {
  await Promise.all([...handles].map((h) => strict ? h.flush(true) : h.flush().catch(() => {})))
}

/** path 上的实例待写先落盘(换实例前用:锁定页面 = 按新 key 重挂,新实例要读到旧实例刚打的字,C-07)。
 *  strict:写失败就 reject(调用方据此不换实例 —— 非严格冲洗把失败吞进保存链照常返回,旧实例一卸载退避重试也没了)。 */
export async function flushUnifiedPath(path: string, strict = false): Promise<void> {
  await Promise.all([...handles].filter((h) => h.path === path).map((h) => (strict ? h.flush(true) : h.flush().catch(() => {}))))
}

/** Account changes retire every cloud editor before its vault root can change. */
export function retireAllUnifiedScopes(): void {
  for (const handle of handles) handle.retire()
}

/** 把文件递给 path 上活着的 unified 实例(侧栏树行拖入等「只知道路径」的入口用;编辑器自己的拖入 / 上传按钮
 *  走本 leaf 的实例写口,不经这里);没有实例接 → false。同篇多开时落到最近用过的那个(G1-02)。 */
export function insertFilesForPath(path: string, files: File[]): boolean {
  for (const h of byRecency(path)) {
    if (h.insertFiles && h.insertFiles(files) !== false) return true
  }
  return false
}

/** 退休 path 上(kind='prefix' 时含子树)的全部实例:防「动完文件,防抖写复活旧路径」。
 *  to = 挪去的新路径(kind='prefix' 时是新的目录前缀):交给实例保全未落盘的字(见 UnifiedPipeHandle.retire)。 */
export function retireUnifiedPath(path: string, kind: 'file' | 'prefix' = 'file', to?: string | null): void {
  for (const h of handles) {
    if (kind === 'file' ? h.path !== path : h.path !== path && !h.path.startsWith(`${path}/`)) continue
    h.retire(to ? (kind === 'file' ? to : to + h.path.slice(path.length)) : undefined)
  }
}

/** 当前挂着 unified 实例的全部路径(去重)。宿主桥断线补课用(评审 G1-04 / G2-01):v4 笔记主要经
 *  readTextFile 打开,不保证设桥的 lastLoadedPage(web 原地分支会设,移动端单列导航 / 分屏其余实例不设),
 *  重连后「凡开着的都回灌一遍」只能从这里取。 */
export function unifiedPaths(): string[] {
  return [...new Set([...handles].map((h) => h.path))]
}

/** path 上是否有属于 scope 这个 leaf(null = 不在面板里)的活实例。草稿分槽认领孤槽时判「那一格的主人还在」(G1-02 返修)。 */
export function unifiedScopeLive(path: string, scope: string | null): boolean {
  for (const h of handles) if (h.path === path && (h.scope ?? null) === scope) return true
  return false
}

/** path 上是否有活着的 unified 实例(= 这篇按 v4 渲染且已挂载)。
 *  v3 的「装载完成」信号是 pageStore.activePage,v4 没有对应物,导航等待用它当就绪判据。 */
export function hasUnifiedInstance(path: string): boolean {
  for (const h of handles) if (h.path === path) return true
  return false
}

/** 只读面板问 path 上那篇的正文;没有 v4 实例 → null(调用方回落 v3 的 blocks)。 */
export function unifiedBody(path: string): string | null {
  for (const h of byRecency(path)) if (h.bodyNow) return h.bodyNow()
  return null
}

/** 状态栏问 path 上那篇的计数(C-22);没有 v4 实例 / 编辑器不在 → null。 */
export function unifiedStats(path: string): import('./noteStats').NoteStats | null {
  for (const h of byRecency(path)) if (h.statsNow) return h.statsNow()
  return null
}

// 计数的刷新节拍(C-22):编辑器里文档或选区变了就 bump(noteStats 的 ticker,一帧最多一次)。与 gen 分开 ——
// 选区每动一下都 bump,不该连带大纲等只关心实例增减的面板一起重算。
let statsVer = 0
const statsListeners = new Set<() => void>()
export function bumpUnifiedStats(): void {
  statsVer++
  for (const f of statsListeners) f()
}
export function unifiedStatsVer(): number {
  return statsVer
}
export function subscribeUnifiedStats(f: () => void): () => void {
  statsListeners.add(f)
  return () => statsListeners.delete(f)
}

/** 只读面板问 path 上那篇的大纲;没有 v4 实例 → null(调用方回落 v3 的 manifest/blocks)。 */
export function unifiedHeadings(path: string): Array<{ level: number; text: string; pos: number }> | null {
  for (const h of byRecency(path)) if (h.headings) return h.headings()
  return null
}

/** 插件块表面问 path 上那篇的外来 frontmatter;没有 v4 实例 → null(调用方回落 v3 的 manifest)。 */
export function unifiedFm(path: string): string | null {
  for (const h of byRecency(path)) if (h.fmNow) return h.fmNow()
  return null
}

/** 插件块表面 / 模板往 path 上那篇插一段 markdown;没有实例 / 实例都不接(只读 / 已退休)→ false。
 *  同篇多开时落到最近用过的那个(G1-02),它不接再问下一个。 */
export function unifiedInsertMarkdown(path: string, md: string, where: 'cursor' | 'start' | 'end'): boolean {
  for (const h of byRecency(path)) if (h.insertMarkdown?.(md, where)) return true
  return false
}

/** 此刻有没有任何 v4 实例开着(G3-08:聊天操作行「插入笔记」没有实例就不出现 —— Mini / 浮窗 / 手机上不挂一排灰按钮)。 */
export function unifiedHasAny(): boolean {
  return handles.size > 0
}

/** 有没有能接住助手回答的 v4 实例(G3-08:聊天操作行「插入笔记」的可用态;实例增减经 subscribeUnified 通知)。 */
export function unifiedHasReplyTarget(): boolean {
  for (const h of handles) if (h.insertReply) return true
  return false
}

/** 把助手回答插回笔记(评审 G3-08)。prefer = 这条对话由「问 Tangu」从哪篇发起:那篇开着就插回那篇(带锚,
 *  落在被引用块之后);没开 / 都不接 → 全窗**最近用过**的那篇(与按路径的路由同一个 lastActive 口径,G1-02),
 *  此时锚属于别的笔记,不带。返回实际落到哪篇(提示要点名)+ 撤销;没有实例接 → null。 */
export function unifiedInsertReply(md: string, prefer?: { path: string; anchor?: ReplyAnchor | null } | null): { path: string; undo: () => boolean } | null {
  if (prefer) {
    for (const h of byRecency(prefer.path)) {
      const r = h.insertReply?.(md, prefer.anchor ?? null)
      if (r) return { path: h.path, undo: r.undo }
    }
  }
  for (const h of byRecency()) {
    const r = h.insertReply?.(md, null)
    if (r) return { path: h.path, undo: r.undo }
  }
  return null
}

/** 正文聚焦(G4-06):落到 path 上最近用过的那个实例(同篇多开时 = 刚被 openNote 激活的那个,G1-02)。
 *  没有实例 / 实例的编辑器还没建好 → false(调用方 focusBodyWhenReady 据此重试几拍)。 */
export function unifiedFocusBody(path: string): boolean {
  for (const h of byRecency(path)) if (h.focusBody) return h.focusBody()
  return false
}

/** path 上最近用过的实例手里的外来 fm 原文(插模板合并属性用,G4-09);没有实例 = null。 */
export function unifiedFmNow(path: string): string | null {
  for (const h of byRecency(path)) if (h.fmNow) return h.fmNow()
  return null
}

/** 块锚点击:让 path 上那篇把尾部挂着 `^id` 的块滚进视野。没有 v4 实例、或那篇里没有这个块 →
 *  false(调用方 openNoteAtBlock 据此重试几拍再放弃 —— 实例挂上但 doc 还空是常态)。 */
export function unifiedRevealBlock(path: string, id: string, flash = false): boolean {
  for (const h of byRecency(path)) if (h.revealBlock) return h.revealBlock(id, flash)
  return false
}

/** 搜索 / 标签命中:让 path 上那篇把第一处命中亮出来。没有 v4 实例、或那篇里没有命中 → false
 *  (调用方 amadeusNav.revealTextWhenReady 据此重试几拍再放弃,同块锚)。 */
export function unifiedRevealText(path: string, needles: string[], opts?: { tag?: boolean; flash?: boolean }): boolean {
  for (const h of byRecency(path)) if (h.revealText) return h.revealText(needles, opts)
  return false
}

/** 大纲点击:让 path 上那篇把第 index 个标题(文本须为 text)滚进视野;没接住返回 false。
 *  flash:落点闪一下(聊天里的 `[[笔记#标题]]` 引用条走这条 —— 那处没有常驻高亮,不闪等于零反馈)。
 *  大纲点击不传:那是用户自己在导航,知道自己点了哪条,不需要提醒。 */
export function unifiedRevealHeading(path: string, index: number, text: string, flash = false): boolean {
  for (const h of byRecency(path)) {
    if (h.revealHeading) {
      h.revealHeading(index, text, flash)
      return true
    }
  }
  return false
}
