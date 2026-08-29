// 聊天气泡里的单个 [[双链]]:解析(vault 绝对路径→相对;resolvePageName 全库匹配)→ 可点链接打开笔记。
// class/data-wiki 与编辑器同款 → 全局挂载的 WikiHoverPreview 悬停浮卡直接吃到,零接线。
import { isValidElement, useMemo, type ReactNode } from 'react'
import { UI_MODE, getView } from '@lcl/engine'
import { linkTarget, resolvePageName } from '@amadeus-shared/links'
import { isHostPath, mediaLabel, parseBlockSubpath, parseLineSubpath, parseMediaLinkInner, parsePdfLinkInner, splitLinkInner, webCiteKey, withTextFragment, type LineLoc, type MediaLoc } from '@amadeus-shared/pdfLink'
import { resolveFileName } from '@amadeus/lib/vaultFiles'
import { usePageStore } from '../amadeus/store/pageStore'
import { splitWiki, wikiLabel } from './wikiChat'
import { sessionIdOfTarget } from '../views/chat2/chatDragRef'

export function ChatWikiLink({ inner }: { inner: string }) {
  const pages = usePageStore((s) => s.pages)
  const files = usePageStore((s) => s.files)
  const root = usePageStore((s) => s.vaultRoot)
  const label = wikiLabel(inner)
  // PDF 引用 `[[书.pdf#page=18]]`(read_document 教 agent 这么写):点开就是那一页。
  // ⚠️ 必须吃**原始 inner**——linkTarget 会把 `#page=` 砍掉,页码就此蒸发(pageStore 同款警告)。
  // ⚠️vault 懒引导:files 只在有人调过 ensureAmadeusReady 之后才有值,空了引用条会全判「未解析」。
  // 这里刻意不自己引:Composer2(桌面/web)与 MobileRoot 挂载时都已经引过,重复引是死码。
  // 真出现「引用条恒灰」,先查那两处还在不在(e2e:pdfcite 的 C1 就是钉这个的)。
  const pdf = useMemo(() => {
    const hit = parsePdfLinkInner(inner)
    if (!hit) return null
    const rel = root && hit.target.startsWith(root + '/') ? hit.target.slice(root.length + 1) : hit.target
    // 库外的 PDF(~/Downloads 里的书之类):引用锚点是绝对路径,库里当然找不着 —— 直接照它开(只读)。
    if (isHostPath(rel)) return { path: rel, page: hit.loc?.page, q: hit.loc?.q, name: rel.split(/[\\/]/).pop() || rel }
    // ⚠️ 只给文件名、而库里同名 PDF 不止一份时,resolveFileName 取字典序首项 = 可能**静默打开另一份**
    // (页码还看着挺合理)。宁可判「未解析」也不猜:read_document 给的锚点本来就是 vault 相对路径,
    // 走 includes('/') 的精确匹配,只有手写的裸文件名才会撞上这条。
    if (!rel.includes('/') && files.filter((f) => f.split('/').pop()?.toLowerCase() === rel.toLowerCase()).length > 1) return null
    const path = resolveFileName(rel, files)
    return path ? { path, page: hit.loc?.page, q: hit.loc?.q, name: rel.split('/').pop() || rel } : null
  }, [inner, root, files])
  // 会话引用(工作区拖会话进聊天):`[[session:<id>|标题]]` —— 不是笔记,别拿去全库匹配
  // (匹配不上会渲染成灰色「未解析」,看着像坏链)。点击 = 打开那个会话。
  const sessionId = sessionIdOfTarget(linkTarget(inner))
  // 媒体时刻引用 `[[lecture.mp4#t=95|01:35]]`(transcribe_audio 教 agent 这么写):点开在应用内
  // 播放器里停在那一秒。同 pdf:必须吃**原始 inner** —— linkTarget 会砍掉 `#t=`,时间戳静默蒸发。
  // ⚠️ 「别被 fileCite 抢走」有**两道闸,任一道单独都够**:本 memo 排在 fileCite 前面 + fileCite
  //    自己看到 media 就让路(下面那行)+ 渲染分支里 media 也排在 fileCite 前面。留双份是因为
  //    抢走的失败形态极隐蔽:库外 `.mp4` 走 fileCite 的 isHostPath 分支(它只排除 `.pdf`),
  //    照样打开、只是**从 0 秒起播**,零报错。
  //    ⚠️ 负对照实测:只拆其中一道 e2e 仍然全绿(另一道兜住了)—— 要验这条得**两道一起拆**,
  //    那时 e2e:mediacite 的 M4 会变成 `at=0`。改这块时别拿「只拆一道还绿」当成没坏。
  // 裸 `[[a.mp4]]`(无锚)刻意不进本分支,维持原有语义(库外走文件条、库内不解析)。
  const media = useMemo(() => {
    // 移动端**刻意交回 fileCite**:载体 `amadeus-asset://` 在 Android 侧没有拦截器(方案 §5 登记
    // 的缺口),开出来是个加载不了的播放器 —— 比让 fileCite 用 WsFileView 从 0 秒打开更坏。
    // ⚠️ 所以移动端上「media 让路闸」是**不生效**的(库外媒体照旧被 fileCite 接走、时刻丢失)——
    //    那是缺口补上前能做到的最好,不是保护失效。桌面端才是本分支说了算。
    if (sessionId || UI_MODE === 'mobile') return null
    const hit = parseMediaLinkInner(inner)
    // ⚠️ **锚点解不开也归本分支**(loc=null),不许掉回 fileCite:方案 §1 写死「非法锚点不许静默
    //    变成 0 秒」。掉回去的形态是库外媒体照样打开、从 0 秒起播、引用条上连个 `@` 都没有,
    //    用户看不出是自己的锚点写错了(`#t=1:35` 这种钟表形态就判非法)。归本分支后:照样开播放器,
    //    但引用条不显示时刻、title 明说锚点无效。裸 `[[a.mp4]]`(**没有 `#`**)仍然不进,维持原有语义。
    if (!hit || !splitLinkInner(inner).subpath) return null
    const rel = root && hit.target.startsWith(root + '/') ? hit.target.slice(root.length + 1) : hit.target
    const name = rel.split(/[\\/]/).pop() || rel
    // 库外(绝对路径 —— transcribe_audio 给的就是这种)→ WsFileView 那条;载体不同,见 openMediaCitation。
    if (isHostPath(rel)) return { abs: rel, vaultRel: null as string | null, name, loc: hit.loc }
    // 裸文件名撞多份同名 → 宁可判未解析也不猜(与 pdf/fileCite 同一条纪律:静默 seek 到另一份
    // 同名视频,而时间码看着还挺合理)。
    if (!rel.includes('/') && files.filter((f) => f.split('/').pop()?.toLowerCase() === rel.toLowerCase()).length > 1) return null
    const p = resolveFileName(rel, files)
    return p ? { abs: p, vaultRel: p, name, loc: hit.loc } : null
  }, [inner, root, files, sessionId])
  // 行号引用 `[[src/a.ts#L42]]` / 库外任意文件 `[[/abs/x.py#L7-L9]]`(read_file 教 agent 这么写):
  // 点开 = WsFileView 滚到那一行并高亮。同 pdf:必须吃**原始 inner**(linkTarget 会把 #L 砍掉)。
  // .pdf 恒归上面的 pdf 分支(渲染时 pdf 先判),这里直接不认,免得两个 memo 抢同一条。
  const fileCite = useMemo(() => {
    if (sessionId || media) return null // 媒体先判(上面);与渲染分支顺序互为冗余,见 media memo 的注释
    const { target, subpath } = splitLinkInner(inner)
    if (!target || /\.pdf$/i.test(target)) return null
    const line = subpath ? parseLineSubpath(subpath) : null
    const rel = root && target.startsWith(root + '/') ? target.slice(root.length + 1) : target
    // 库外文件:锚点是绝对路径,带不带行号都开(WsFileView 通吃,.md 也有编辑器)。
    if (isHostPath(rel)) return { abs: rel, name: rel.split(/[\\/]/).pop() || rel, line }
    // 库内文件:只有带行号锚的才进本分支(裸 [[笔记]]/[[附件]] 维持原有语义);
    // 拼绝对路径喂 WsFileView 需要 vaultRoot。裸文件名撞多份同名 → 宁可不解析(同 pdf 分支)。
    // Office 文档(docx/xlsx/pptx)即使没有锚点也进本分支:它们**没有可用的锚点形态**
    // —— read_document 的页码来自 LibreOffice 排版,与用户在 Word 里看到的分页无必然对应,
    // 所以引擎只教裸 `[[路径]]`(见 hostExec.ts 的 citeHow)。不放行的话库内 Office 引用恒灰。
    // 老消息里的 `[[资料/x.docx#page=3]]` 也从这里优雅降级:解不出行号 → line=null → 照样开,页码忽略。
    // ⚠️ 白名单刻意只到这三类,**不做通用放宽**:.db / 画板 / 插件声明的文件类型各有专属视图,
    //    通用放宽 = 拿**错的视图**打开(比渲染成灰链更坏)。
    const office = /\.(docx?|xlsx?|pptx?)$/i.test(rel)
    if ((!line && !office) || !root) return null
    if (!rel.includes('/') && files.filter((f) => f.split('/').pop()?.toLowerCase() === rel.toLowerCase()).length > 1) return null
    const p = resolveFileName(rel, files)
    return p ? { abs: `${root}/${p}`, name: rel.split('/').pop() || rel, line } : null
  }, [inner, root, files, sessionId, media])
  // 笔记的块锚点 `[[笔记#^abc]]`(Obsidian 互操作:从那边导入的笔记正文里本来就带 `^id`,
  // 本仓自己一行都不产)。点开 = 滚到那个块并闪一下,只在 v4 渲染的笔记上跳得动(见 openNoteAtBlock)。
  const blockId = useMemo(() => {
    const { subpath } = splitLinkInner(inner)
    return subpath ? parseBlockSubpath(subpath) : null
  }, [inner])
  // 笔记的标题锚点 `[[笔记#标题]]`:打开后滚到那个标题。标题是**兜底**分支(什么都接),
  // 所以行号 / 块锚两族必须先判掉。`^` 开头一律不当标题 —— 包括 parseBlockSubpath 认不出的
  // 畸形形态(`#^a b`),那种照旧只开笔记,不去撞一个叫 "^a b" 的标题。
  const heading = useMemo(() => {
    const { subpath } = splitLinkInner(inner)
    if (!subpath || parseLineSubpath(subpath) || subpath.startsWith('^')) return null
    return subpath
  }, [inner])
  const path = useMemo(() => {
    if (sessionId) return null
    const target = linkTarget(inner)
    const rel = root && target.startsWith(root + '/') ? target.slice(root.length + 1) : target
    return resolvePageName(rel, pages)
  }, [inner, root, pages, sessionId])
  if (sessionId) {
    return (
      <a className="wikilink" onClick={() => { void import('../sessionNav').then((m) => m.openSession(sessionId)) }}>
        {label}
      </a>
    )
  }
  if (pdf) {
    // 引用锚点现在是 vault 相对路径(见 read_document),原样显示会把 `资料/论文集/xxx.pdf` 怼进正文;
    // 没写别名就显示「文件名 p.N」—— 别名照旧优先。
    // 书名可以很长(「… (z-library.sk, 1lib.sk, z-lib.sk).pdf」),原样铺进正文会占三行 —— 掐头留尾,
    // 全路径挂 title 里(悬停可见)。有别名时永远以别名为准。
    const short = pdf.name.length > 26 ? `${pdf.name.slice(0, 24)}…` : pdf.name
    const text = inner.includes('|') ? label : pdf.page ? `${short} p.${pdf.page}` : short
    return (
      <a className="wikilink" data-wiki={pdf.path} title={pdf.path} onClick={() => { void openPdfCitation(pdf.path, pdf.page, pdf.q) }}>
        {text}
      </a>
    )
  }
  if (media) {
    // 时刻引用条:「文件名 @01:35」(与笔记里嵌入播放器的 `@` 徽标同口径);别名照旧优先。
    // 锚点解不开时**不显示时刻**、title 明说无效 —— 那就是「非法锚点不许静默变 0 秒」在引用条上的形态。
    const short = media.name.length > 26 ? `${media.name.slice(0, 24)}…` : media.name
    const stamp = media.loc ? `@${mediaLabel(media.loc.at)}${media.loc.to ? `–${mediaLabel(media.loc.to)}` : ''}` : ''
    const text = inner.includes('|') ? label : stamp ? `${short} ${stamp}` : short
    // 「降级 ≠ 静默」:用户写了终点但它坏掉(`t=95,80`)时,起点照用、终点忽略,但 title 得说一声。
    const tip = !media.loc ? `${media.abs}(时刻锚点无效,从头播放)`
      : media.loc.badTo ? `${media.abs} ${stamp}(区间终点无效,已忽略)`
        : `${media.abs} ${stamp}`
    return (
      <a className="wikilink" data-wiki={media.abs} title={tip} onClick={() => { void openMediaCitation(media) }}>
        {text}
      </a>
    )
  }
  if (fileCite) {
    // 行号引用条:Cursor 式「文件名:42」;别名照旧优先,全路径挂 title。
    const short = fileCite.name.length > 26 ? `${fileCite.name.slice(0, 24)}…` : fileCite.name
    const lineTag = fileCite.line ? `:${fileCite.line.from}${fileCite.line.to ? `-${fileCite.line.to}` : ''}` : ''
    const text = inner.includes('|') ? label : `${short}${lineTag}`
    return (
      <a className="wikilink" data-wiki={fileCite.abs} title={`${fileCite.abs}${lineTag}`} onClick={() => { void openFileCitation(fileCite.abs, fileCite.name, fileCite.line) }}>
        {text}
      </a>
    )
  }
  if (!path) return <span className="wikilink wikilink-unresolved">{label}</span>
  // 无别名的标题引用(read_file 教的 `[[dir/笔记.md#标题]]`)别把整条路径怼进正文:显示「笔记 › 标题」。
  const noteText = !inner.includes('|') && (heading || blockId)
    ? `${path.split('/').pop()!.replace(/\.md$/i, '')} › ${heading ?? `^${blockId}`}`
    : label
  return (
    <a
      className="wikilink"
      data-wiki={path}
      onClick={() => {
        // 懒加载防 barrel 循环,web 侧同样可用;带标题/块锚点 → 打开后滚到那个位置
        void import('../amadeusNav').then((m) => (
          blockId ? m.openNoteAtBlock(path, blockId)
            : heading ? m.openNoteAtHeading(path, heading)
              : m.openNote(path)))
      }}
    >
      {noteText}
    </a>
  )
}

/** 引用点击:Desk 开着就在演出区就地开(引用与对话并排,ChatGPT 式),否则退主区 tab。
 *  两处都懒加载:本模块也给 Amadeus 侧的气泡用,静态引 appStore/amadeusNav 会绕出 barrel 环。 */
async function openPdfCitation(path: string, page?: number, quote?: string): Promise<void> {
  const { useApp } = await import('../stores/appStore')
  const { activeId, desktopConfig } = useApp.getState()
  // 闸门必须与 ChatView 的 deskEnabled 逐字同源:移动端根本不挂 AgentDesk,
  // 只按 agentDeskEnabled 判会把状态写进一个不存在的面板 = 点了没反应。
  if (UI_MODE !== 'mobile' && desktopConfig?.agentDeskEnabled && activeId) {
    const top = useApp.getState().deskBySession[activeId]?.items?.[0]
    const same = top?.view?.type === 'amadeus-pdf' && top.view.params?.pdfPath === path
    // 落状态:deskShowFile 对同一份 PDF 复用原 key(不 remount 重下),params 的新页码供**下次冷挂载**
    // (刷新后从快照恢复)用;DeskShimView 的 leaf 只按 key 记忆,params 变化不会灌进已挂载的视图。
    const params: Record<string, unknown> = { pdfPath: path }
    if (page) params.page = page
    if (quote) params.q = quote
    useApp.getState().deskShowFile(activeId, path, { type: 'amadeus-pdf', params })
    // 已挂载(或正在装载)的阅读器由它自己听的 amadeus:pdf-goto 跳 —— 装载中到的事件被 PdfAnnotator
    // 的 pendingGoto 记着,pagesinit 时补跳(openPdf 激活既有 tab 走的也是这条通路)。
    if (same && page) window.dispatchEvent(new CustomEvent('amadeus:pdf-goto', { detail: { pdfPath: path, page, q: quote } }))
    return
  }
  const { openPdf } = await import('../amadeusNav')
  openPdf(path, page, quote ? { quote } : undefined)
}

/** 行号/文件引用点击:同 PDF —— Desk 开着就在演出区开 WsFileView,否则退主区 tab。
 *  ⚠️直播格碰撞(agent 正在流式编辑同一份文件):deskShowFile 会保住直播格不打断,此时
 *  goto 事件没有 WsFileView 接 —— 刻意如此(流式演出优先),编辑一结束格子落盘,再点就正常。 */
async function openFileCitation(path: string, name: string, line: LineLoc | null): Promise<void> {
  const { useApp } = await import('../stores/appStore')
  const { activeId, desktopConfig } = useApp.getState()
  if (UI_MODE !== 'mobile' && desktopConfig?.agentDeskEnabled && activeId) {
    const top = useApp.getState().deskBySession[activeId]?.items?.[0]
    const same = top?.view?.type === 'wsfile' && top.view.params?.path === path
    const params: Record<string, unknown> = { path, name }
    if (line) { params.line = line.from; if (line.to) params.endLine = line.to }
    useApp.getState().deskShowFile(activeId, path, { type: 'wsfile', params })
    // 已挂载的视图由它自己听的 amadeus:wsfile-goto 跳(pdf-goto 同款通路);
    // 不带行号的同文件引用发 clear,别让上一条引用的高亮/源码锁残留(openWsFile 同款,Codex 二审)。
    if (same) {
      window.dispatchEvent(new CustomEvent('amadeus:wsfile-goto', line
        ? { detail: { path, line: line.from, endLine: line.to } }
        : { detail: { path, clear: true } }))
    }
    return
  }
  const { openWsFile, hostTargetFor } = await import('../views/wsFileNav')
  openWsFile(hostTargetFor(path, name), line ? { line: line.from, endLine: line.to } : undefined)
}

/** 媒体时刻引用点击。两个载体,按**库内/库外**分:
 *  - 库内 → `amadeus-media` 视图(`amadeus-asset://`,主进程 fd 区间流式读,GB 级视频也不卡);
 *  - 库外(绝对路径,transcribe_audio 给的就是这种)→ WsFileView(它认 video/audio),
 *    因为 asset 协议只有 `v/<vaultRel>` 一个面,没有 host 路径面。
 *  两条都是「Desk 开着就在演出区并排开,否则退主区 tab」——与 PDF/行号引用条同一条纪律。
 *  ⚠️ 同一份媒体的第二个时刻**必须靠事件就地跳**:DeskShimView 的 leaf 只按 key memo,
 *     改 params 到不了已挂载的视图(pdf/wsfile/browser 三处同款坑),换 key 则等于重挂 = 重新起流。 */
async function openMediaCitation(m: { abs: string; vaultRel: string | null; name: string; loc: MediaLoc | null }): Promise<void> {
  const { useApp } = await import('../stores/appStore')
  const { activeId, desktopConfig } = useApp.getState()
  const desk = UI_MODE !== 'mobile' && desktopConfig?.agentDeskEnabled && activeId ? activeId : null
  if (m.vaultRel) {
    if (desk) {
      const top = useApp.getState().deskBySession[desk]?.items?.[0]
      const same = top?.view?.type === 'amadeus-media' && top.view.params?.path === m.vaultRel
      const params: Record<string, unknown> = { path: m.vaultRel }
      if (m.loc) { params.at = m.loc.at; if (m.loc.to) params.to = m.loc.to }
      useApp.getState().deskShowFile(desk, m.vaultRel, { type: 'amadeus-media', params }, m.name)
      // 已挂载的播放器由 MediaPlayer 自己听的 `amadeus:media-goto` 认领(方案 §2 明令不复用
      // pdf-goto/wsfile-goto:那两个的 detail 各有消费方按字段名解构)。
      if (same && m.loc) window.dispatchEvent(new CustomEvent('amadeus:media-goto', { detail: { path: m.vaultRel, at: m.loc.at, to: m.loc.to, handled: false } }))
      return
    }
    const { openMedia } = await import('../amadeusNav')
    openMedia(m.vaultRel, m.loc ?? undefined)
    return
  }
  if (desk) {
    const top = useApp.getState().deskBySession[desk]?.items?.[0]
    const same = top?.view?.type === 'wsfile' && top.view.params?.path === m.abs
    // 区间锚 `#t=95,120` 的终点也要带上 —— 只传 at 的话「到点暂停」在库外媒体上静默失效
    // (库内那条走 MediaPlayer 本来就有,两边不对称才是坑)。
    const params: Record<string, unknown> = { path: m.abs, name: m.name }
    if (m.loc) { params.t = m.loc.at; if (m.loc.to) params.tTo = m.loc.to }
    useApp.getState().deskShowFile(desk, m.abs, { type: 'wsfile', params })
    if (same && m.loc) window.dispatchEvent(new CustomEvent('amadeus:wsfile-goto', { detail: { path: m.abs, t: m.loc.at, tTo: m.loc.to } }))
    return
  }
  const { openWsFile, hostTargetFor } = await import('../views/wsFileNav')
  openWsFile(hostTargetFor(m.abs, m.name), m.loc ? { t: m.loc.at, tTo: m.loc.to } : undefined)
}

/** 聊天里的普通网页链接 = 网页引用条:点开在 Agent Desk 的内置浏览器里并排打开,
 *  并滚到链接文字那句话(Chromium 原生 `#:~:text=`,见 withTextFragment)。
 *  外观刻意**不动** —— 网页引用天生带标题文字,套成灰色文件条只会更难读。
 *  Desk 用不上(关着/移动端/内置浏览器被禁)时**不拦**,交回默认流程(主进程回投 → 主区标签
 *  或系统浏览器,还受「应用内链接」开关管)。 */
export function ChatWebLink({ href, children, quote, ...rest }: { href: string; children?: ReactNode; quote?: string } & Record<string, unknown>) {
  return (
    <a
      href={href}
      {...rest}
      // 调用方自带 className = 它自己管观感(任务总结卡的来源行就是),别再叠 citelink 的下划线;
      // 没给 = 这是正文里的行内链接,挂 citelink 由样式表统一给「可点」信号。
      className={rest.className ? String(rest.className) : 'citelink'}
      onClick={(e) => {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        // 判不了就别拦:preventDefault 必须在动态 import **之前**同步发生,回头再想放行已经来不及,
        // 所以先用同步能拿到的两个闸(移动端 / 内置浏览器被关)劝退,拦下了就自己负责兜底出口。
        if (UI_MODE === 'mobile' || !getView('browser')) return
        e.preventDefault()
        // quote 显式给了就用它(给空串 = 只打开不定位);没给才拿链接文字当引语。
        // 来源行那种「标签是主机名 + ×3 命中数」的地方必须显式给空,否则拿去当搜索词纯属噪音。
        void openWebCitation(href, quote === undefined ? textOf(children) : quote).then((took) => {
          if (!took) void import('../builtins').then((m) => m.routeExternalUrl(href))
        })
      }}
    >
      {children}
    </a>
  )
}

/** React 子树 → 纯文本(链接文字可能被 <em>/<code> 拆成好几节)。 */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** 网页引用点击:Desk 开着就在演出区开内置浏览器(引用与对话并排),否则返回 false 交回默认流程。
 *  同一页的第二条引语**必须复用同一个 webview**(换 key = 重挂 = 整页重下),就地跳靠
 *  amadeus:browser-goto —— DeskShimView 的 leaf 只按 key memo,改 params 到不了已挂载的视图
 *  (PDF/WsFileView 同款通路,别再试写 params)。 */
async function openWebCitation(href: string, quote: string): Promise<boolean> {
  if (UI_MODE === 'mobile') return false
  const { useApp } = await import('../stores/appStore')
  const { activeId, desktopConfig } = useApp.getState()
  if (!desktopConfig?.agentDeskEnabled || !activeId) return false
  // ⚠️ Markdown 组件不只聊天在用(更新日志/设置/市场/收件箱/右栏/WsFileView…共 14 处调用点),
  // 而 activeId 在别的标签页上照样有值 —— 只按它判,会把非聊天面里的链接写进一块**看不见的 Desk**,
  // 观感 = 点了没反应。判据取「这个会话的 Desk 真挂在 DOM 上」:AgentDesk 与常驻的 DeskCard
  // 都带 data-desk-session(卡片不可关,聊天视图在场就必有一个)。
  if (!document.querySelector(`[data-desk-session="${CSS.escape(activeId)}"]`)) return false
  const url = withTextFragment(href, quote)
  const key = webCiteKey(href)
  const top = useApp.getState().deskBySession[activeId]?.items?.[0]
  const same = top?.view?.type === 'browser' && top.view.params?.path === key
  useApp.getState().deskShowFile(activeId, key, { type: 'browser', params: { url, path: key } }, hostLabel(key))
  if (same) window.dispatchEvent(new CustomEvent('amadeus:browser-goto', { detail: { path: key, url } }))
  return true
}

/** Desk 卡片标题用的短名:主机名去掉 www.(整条 URL 铺进卡头会挤掉别的)。 */
function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/** 用户气泡纯文本:[[..]] → 双链,其余原样(pre-wrap 换行不受影响)。 */
export function WikiText({ text }: { text: string }) {
  const pieces = splitWiki(text)
  if (pieces.length === 1 && !pieces[0].wiki) return <>{text}</>
  return <>{pieces.map((p, i) => (p.wiki ? <ChatWikiLink key={i} inner={p.wiki.inner} /> : p.text))}</>
}
