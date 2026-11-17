/** 模板与日记:vault 的 templates/ 文件夹即模板库;插入时替换 {{date}}/{{time}}/{{title}} 变量
 *  (含 `{{date:fmt}}` 等 Obsidian 写法,变量与日记命名的规则见 amadeus/lib/templateVars,评审 G4-10)。
 *  模板经只读 readPage 读取(不污染「上次打开」),块按布局顺序摊平插入(多列模板 v1 摊平)。
 *
 *  两条落地路由(2026-08-21):
 *  - **v3**(块编辑器):照旧逐块插 —— afterId 之后依序排,光标块为空则首块填进它。
 *  - **v4/unified**:那篇没有块 id,块寻址一律被拒。整份模板拼成一段 markdown,经
 *    unified/lifecycle 的 `insertMarkdown` 接缝插在光标处(空块由 UnifiedPage 的 insertMd
 *    原地替换,「首块填进空块」的语义在那边免费拿到)。 */
import { amadeus } from '@amadeus/api'
import { activePageScope, birthNavGuard, birthNoteFile, noteOf, usePageStore } from '@amadeus/store/pageStore'
import { compile, parsePageSource } from '@amadeus-shared/compiler'
import { hasTemplateProcessors, normTemplateFolder, runTemplateProcessors } from '@amadeus/plugins/templateHooks'
import type { TemplateFlowKind } from '@amadeus/plugins/types'
import { unifiedFmNow, unifiedInsertMarkdown, unifiedPatchFm } from '@amadeus/unified/lifecycle'
import { BLOCK_MARKER_RE } from '@amadeus-shared/compiler/markers'
import { parseFmObject } from '@amadeus-shared/db/pageFrontmatter'
import { templateFmPatch } from './amadeusTemplateFm'
import { openNote } from './amadeusNav'
import type { TemplateCtx } from './amadeusOverlayStore'
import { dailyNotePath, dailyTemplatePath, parseObsidianCfg, substituteTemplateVars, type ObsidianDailyCfg, type ObsidianTemplatesCfg } from '@amadeus/lib/templateVars'
import { currentLocale } from './i18n'

const ps = () => usePageStore.getState()

/** 模板库:`templates/` 下的笔记,加上插件声明的模板文件夹(ctx.registerTemplateProcessor 的 folders(),2026-11-16+;
 *  由选择器异步取来传进来)。库外 / 带 `..` 的文件夹不认;同一篇只列一次。 */
export function listTemplates(extraFolders: readonly string[] = []): string[] {
  const extra = extraFolders.map(normTemplateFolder).filter((f): f is string => !!f).map((f) => `${f.toLowerCase()}/`)
  return ps().pages.filter((p) => /^templates\//i.test(p) || extra.some((f) => p.toLowerCase().startsWith(f)))
}

/** 读库里的 Obsidian 核心插件配置(`.obsidian/<name>.json`);读不到 / 读不懂 = 空(一律回落缺省)。 */
async function obsidianCfg<T extends object>(name: string): Promise<Partial<T>> {
  const raw = await amadeus.readTextFile?.(`.obsidian/${name}.json`)?.catch(() => null)
  return parseObsidianCfg<T>(raw)
}

/** 变量替换。⚠️ 标题取**目标笔记**的名字,不是 store 的 activePage —— v4 从不设 activePage,
 *  照老写法 {{title}} 在统一实例上恒为空串(与块表面令牌恒 '#0' 同一类坑)。 */
function substitute(content: string, targetPath: string, cfg: Partial<ObsidianTemplatesCfg>): string {
  const title = (targetPath.split('/').pop() ?? '').replace(/\.md$/i, '')
  return substituteTemplateVars(content, { title, dateFormat: cfg.dateFormat, timeFormat: cfg.timeFormat, locale: currentLocale() })
}

/** 值里的字符串逐个替换变量(列表 / 嵌套对象递归);其它类型原样。 */
function substituteValue(v: unknown, targetPath: string, cfg: Partial<ObsidianTemplatesCfg>): unknown {
  if (typeof v === 'string') return substitute(v, targetPath, cfg)
  if (Array.isArray(v)) return v.map((x) => substituteValue(x, targetPath, cfg))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteValue(x, targetPath, cfg)]))
  return v
}

/** 模板文件的块内容(按布局顺序摊平,已替换变量)。
 *  ⚠️ 剥掉块标记行:v4 结构化模板没有 `amadeus_page` 键,readPage 走的是 importForeign ——
 *  整份原文当一个块,`<!-- a id -->` 会原样跟着插进目标笔记。正则从 markers.ts 取,别再抄一份。 */
function templateBlocks(page: Awaited<ReturnType<typeof amadeus.readPage>>, targetPath: string, cfg: Partial<ObsidianTemplatesCfg>): string[] {
  const out: string[] = []
  for (const row of page.manifest.root.children) {
    for (const col of row.columns) {
      for (const ref of col.children) {
        const raw = page.blocks[ref.ref]?.content ?? ''
        const c = raw.split('\n').filter((l) => !BLOCK_MARKER_RE.test(l)).join('\n')
        if (c.trim()) out.push(substitute(c, targetPath, cfg))
      }
    }
  }
  return out
}

/** 往 v4 笔记插一段 markdown,**等实例能收字为止**。
 *  刚建的日记走的是「建文件 → 导航 → 路由分类 → UnifiedPage 挂载 → Milkdown 起实例」这条链,
 *  openNote 的就绪等待只等到「pipe 登记上」且有 3s 上限,Milkdown 实例比它还晚 —— 一次性调用
 *  的失败表现是「日记建出来了但模板一个字没有」(2026-08-21 真机实测到的就是这个)。
 *  返回 false 才是真没插进去:insertMd 只在**真的 dispatch 了**才返回 true,重试不会插两遍。 */
async function insertIntoUnified(path: string, md: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (unifiedInsertMarkdown(path, md, 'cursor')) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/** 模板 fm 并进 v4 笔记(G4-09):经实例的 fm 写口 unifiedPatchFm(与属性面板同一条外科写、单写者管线);
 *  目标已有的键不覆盖,tags / aliases 取并集(templateFmPatch)。与 insertIntoUnified 同理等实例就绪(只有 fm、
 *  没有正文的模板不经过那一步等待)。没有要改的也算成功。 */
async function patchIntoUnified(path: string, tplFm: Record<string, unknown>, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const cur = unifiedFmNow(path)
    if (cur != null) {
      const patch = templateFmPatch(tplFm, parseFmObject(cur))
      if (!patch) return true
      const done = unifiedPatchFm(path, patch)
      if (done) {
        await done
        return true
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

type TemplatePage = Awaited<ReturnType<typeof amadeus.readPage>>

/** 按布局顺序摊平的块原文(不替换变量)+ fm:判断两份解析是不是同一份内容。 */
const pageShape = (page: TemplatePage): string => JSON.stringify([page.manifest.fmExtra ?? '', page.manifest.root.children.flatMap((row) => row.columns.flatMap((col) => col.children.map((ref) => page.blocks[ref.ref]?.content ?? '')))])

/** 读模板。有插件的模板处理器(ctx.registerTemplateProcessor)时,先把**原文**交给它们(宿主替换变量之前);
 *  谁都没改 = 照旧 readPage(一字不差的老路)。某个处理器抛错 = null:这次插入作废(已提示),什么都不写。 */
async function readTemplatePage(templatePath: string, targetPath: string, kind: TemplateFlowKind): Promise<TemplatePage | null> {
  // readPage 先读:它是正典(v1 侧车 / v2 目录这类老格式在这一步迁成 v3 落盘),也照旧负责「缺文件就抛」。
  const page = await amadeus.readPage(templatePath)
  if (!hasTemplateProcessors()) return page
  // 交给插件的「原文」= 盘上那份 —— 前提是它解析出来就是 readPage 那份;对不上(老格式没迁成等)就用正典重新编出来的源码。
  const raw = await amadeus.readTextFile?.(templatePath)
  const now = new Date().toISOString()
  let source = raw
  if (raw == null || pageShape(parsePageSource(templatePath, raw, now)) !== pageShape(page)) {
    try {
      source = compile(page.manifest, Object.fromEntries(Object.entries(page.blocks).map(([id, b]) => [id, b.content])))
    } catch {
      if (raw == null) return page // 编不出来又读不到原文(未来格式等):不交给插件,照旧插
    }
  }
  if (source == null) return page
  const r = await runTemplateProcessors(source, { templatePath, targetPath, kind })
  if (!r.ok) return null
  if (!r.changed) return page
  return parsePageSource(templatePath, r.text, now) // 与 readPage 同一个解析(纯函数,不碰盘)
}

/** 把模板插进目标笔记。ctx.v4Path 在场 = 统一实例路由;否则走 v3 的块坐标。kind 告诉模板处理器是哪条流程。 */
export async function insertTemplate(templatePath: string, ctx: TemplateCtx, kind: TemplateFlowKind = 'insert'): Promise<void> {
  const target = ctx.v4Path ?? noteOf(ps()) ?? ''
  const root = ps().vaultRoot
  const scope = activePageScope()
  const viaPlugins = hasTemplateProcessors() // 有处理器 = 这次插入可能等很久(见下面的复核)
  const [page, cfg] = await Promise.all([readTemplatePage(templatePath, target, kind), obsidianCfg<ObsidianTemplatesCfg>('templates')])
  if (!page) return
  // 插件的模板处理器可能等很久(弹框问用户):等的途中换了库 = 不插(同路径的笔记已是另一个库的);v3 那条还按块坐标写,
  // 换了面板 / 换了笔记 / 那一块没了 = 不插,别把模板写进别的笔记的同号块(Codex 复核 P1)。
  if (ps().vaultRoot !== root) return
  if (!ctx.v4Path && (activePageScope() !== scope || (noteOf(ps()) ?? '') !== target || (ctx.afterId && !ps().blocks[ctx.afterId]))) return
  const contents = templateBlocks(page, target, cfg)
  // 模板自带的 frontmatter(G4-09):此前整段丢弃。v4 经实例的 fm 写口(unifiedPatchFm,与属性面板同一条外科写)合并。
  // fm 值里的变量与正文同一套规则替换(G4-10 templateVars:`{{date:fmt}}`、大小写 / 空白容忍、templates.json 缺省格式)。
  const tplFm = page.manifest.fmExtra ? (substituteValue(parseFmObject(page.manifest.fmExtra), target, cfg) as Record<string, unknown>) : {}
  if (!contents.length && !Object.keys(tplFm).length) return
  if (ctx.v4Path) {
    // 块之间空行分隔 = 与 compile() 写盘时的段落间距同形,插进去按原样重新分块呈现。
    if (contents.length && !(await insertIntoUnified(ctx.v4Path, contents.join('\n\n')))) {
      console.warn(`[amadeus] 模板插入失败:${ctx.v4Path} 上没有能收字的统一实例`)
      return
    }
    if (Object.keys(tplFm).length && !(await patchIntoUnified(ctx.v4Path, tplFm))) {
      console.warn(`[amadeus] 模板属性未写入:${ctx.v4Path} 上没有能收 fm 的统一实例`)
    }
    return
  }
  // ponytail: v3 块编辑器路径不合并模板 fm(v4「打开即升」后只剩旧宿主在用)。
  if (!contents.length) return
  const st = ps()
  let rest = contents
  // 等处理器的途中那一块被打了字:不覆盖,改插在它后面。没有处理器时照旧信编辑器开选择器那一刻的判断。
  if (ctx.emptyBlock && ctx.afterId && !(viaPlugins && st.blocks[ctx.afterId]?.content.trim())) {
    st.setBlockContent(ctx.afterId, contents[0])
    rest = contents.slice(1)
  }
  if (rest.length) st.insertBlocksAfter(ctx.afterId ?? null, rest)
}

/** 打开(或创建)今天的日记;新建时套日记模板。文件夹取 设置→笔记→日记文件夹;名字格式 / 模板 / 设置里没填时的
 *  文件夹取库里 Obsidian「日记」插件的配置(`.obsidian/daily-notes.json`,评审 G4-10),都没有 = `YYYY-MM-DD.md`
 *  + `templates/daily.md`。 */
export async function openDailyNote(): Promise<void> {
  if (!ps().vaultRoot) return
  const [cfg, daily] = await Promise.all([
    window.tangu?.getConfig?.().catch(() => null),
    obsidianCfg<ObsidianDailyCfg>('daily-notes'),
  ])
  const path = dailyNotePath(new Date(), cfg?.notesDailyFolder, daily, currentLocale())
  // 「已经有没有」以**磁盘**为准:pages[] 可能落后于磁盘,照它判会把已有日记当新的再套一遍模板。
  // 素文件出生(与 createPageInFolder 同规,走同一个 birthNoteFile)。老路 openOrCreate → 主进程 newPage 生的是 v3
  // (amadeus_page + 块标记),而「打开即升」默认开 → 路由当场把它交给 UnifiedPage,模板往
  // 交出去的 v3 store 里写,写完即被冲掉:日记建出来但一个字都没有(2026-08-21 真机实测)。
  // 别处刚建了同名(宿主仅新建交回现文)= 已存在,照常打开、不套模板;没建成(已提示)→ 不打开一篇不存在的笔记。
  // 有日记模板 → 照旧出生后套模板(模板处理器按 'daily' 跑);没有 → 这是一篇空的新笔记,先问插件(registerNoteBirth)要初始内容。
  const tplBefore = dailyTemplatePath(ps().pages, daily)
  // 没有日记模板时要先问插件、可能等很久:等完用户已去了别处就只建不开。有模板时不问插件,照旧打开并套模板
  // (这里提前返回的话,空着出生的日记下次打开已是「存在」,模板就再也套不上了)。
  const stay = tplBefore ? () => true : birthNavGuard()
  const born = await birthNoteFile(path, tplBefore ? undefined : { ask: true })
  if (born === 'failed') return
  const existed = born === 'exists'
  if (!existed) await ps().refreshStructure()
  if (!stay()) return
  // 内部等就绪:v3 等 activePage,v4 等 unified 实例登记。focus:'body' = 进来就能打字(G4-06;新日记没套模板时同样要)。
  await openNote(path, { focus: 'body' })
  if (existed) return
  const tpl = dailyTemplatePath(ps().pages, daily) // 照旧按刷新后的清单找(出生前那份可能落后)
  if (!tpl) return
  // 出生前没看到模板 → 问过插件;插件已经给了内容就别再叠一份日记模板上去。
  if (!tplBefore && ((await amadeus.readTextFile?.(path)?.catch(() => null)) ?? '') !== '') return
  // 模板读取失败(被删等)不影响日记本体。
  await insertTemplate(tpl, { v4Path: path }, 'daily').catch(() => { /* ignore */ })
}
