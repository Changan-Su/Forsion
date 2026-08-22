/** 模板与日记:vault 的 templates/ 文件夹即模板库;插入时替换 {{date}}/{{time}}/{{title}} 变量。
 *  模板经只读 readPage 读取(不污染「上次打开」),块按布局顺序摊平插入(多列模板 v1 摊平)。
 *
 *  两条落地路由(2026-08-21):
 *  - **v3**(块编辑器):照旧逐块插 —— afterId 之后依序排,光标块为空则首块填进它。
 *  - **v4/unified**:那篇没有块 id,块寻址一律被拒。整份模板拼成一段 markdown,经
 *    unified/lifecycle 的 `insertMarkdown` 接缝插在光标处(空块由 UnifiedPage 的 insertMd
 *    原地替换,「首块填进空块」的语义在那边免费拿到)。 */
import { amadeus } from '@amadeus/api'
import { noteOf, usePageStore } from '@amadeus/store/pageStore'
import { unifiedInsertMarkdown } from '@amadeus/unified/lifecycle'
import { BLOCK_MARKER_RE } from '@amadeus-shared/compiler/markers'
import { openNote } from './amadeusNav'
import type { TemplateCtx } from './amadeusOverlayStore'

const ps = () => usePageStore.getState()
const pad = (n: number): string => String(n).padStart(2, '0')

export const todayStr = (d = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function listTemplates(): string[] {
  return ps().pages.filter((p) => /^templates\//i.test(p))
}

/** 变量替换。⚠️ 标题取**目标笔记**的名字,不是 store 的 activePage —— v4 从不设 activePage,
 *  照老写法 {{title}} 在统一实例上恒为空串(与块表面令牌恒 '#0' 同一类坑)。 */
function substitute(content: string, targetPath: string): string {
  const d = new Date()
  const title = (targetPath.split('/').pop() ?? '').replace(/\.md$/i, '')
  return content
    .replaceAll('{{date}}', todayStr(d))
    .replaceAll('{{time}}', `${pad(d.getHours())}:${pad(d.getMinutes())}`)
    .replaceAll('{{title}}', title)
}

/** 模板文件的块内容(按布局顺序摊平,已替换变量)。
 *  ⚠️ 剥掉块标记行:v4 结构化模板没有 `amadeus_page` 键,readPage 走的是 importForeign ——
 *  整份原文当一个块,`<!-- a id -->` 会原样跟着插进目标笔记。正则从 markers.ts 取,别再抄一份。 */
function templateBlocks(page: Awaited<ReturnType<typeof amadeus.readPage>>, targetPath: string): string[] {
  const out: string[] = []
  for (const row of page.manifest.root.children) {
    for (const col of row.columns) {
      for (const ref of col.children) {
        const raw = page.blocks[ref.ref]?.content ?? ''
        const c = raw.split('\n').filter((l) => !BLOCK_MARKER_RE.test(l)).join('\n')
        if (c.trim()) out.push(substitute(c, targetPath))
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

/** 把模板插进目标笔记。ctx.v4Path 在场 = 统一实例路由;否则走 v3 的块坐标。 */
export async function insertTemplate(templatePath: string, ctx: TemplateCtx): Promise<void> {
  const page = await amadeus.readPage(templatePath)
  const target = ctx.v4Path ?? noteOf(ps()) ?? ''
  const contents = templateBlocks(page, target)
  if (!contents.length) return
  if (ctx.v4Path) {
    // 块之间空行分隔 = 与 compile() 写盘时的段落间距同形,插进去按原样重新分块呈现。
    if (!(await insertIntoUnified(ctx.v4Path, contents.join('\n\n')))) {
      console.warn(`[amadeus] 模板插入失败:${ctx.v4Path} 上没有能收字的统一实例`)
    }
    return
  }
  const st = ps()
  let rest = contents
  if (ctx.emptyBlock && ctx.afterId) {
    st.setBlockContent(ctx.afterId, contents[0])
    rest = contents.slice(1)
  }
  if (rest.length) st.insertBlocksAfter(ctx.afterId ?? null, rest)
}

/** 打开(或创建)今天的日记;新建时若存在 templates/daily.md 自动套用。文件夹取 设置→笔记→日记文件夹。 */
export async function openDailyNote(): Promise<void> {
  if (!ps().vaultRoot) return
  const cfg = await window.tangu?.getConfig?.().catch(() => null)
  const folder = (cfg?.notesDailyFolder ?? '').trim().replace(/^\/+|\/+$/g, '')
  const name = `${todayStr()}.md`
  const path = folder ? `${folder}/${name}` : name
  // 「已经有没有」以**磁盘**为准:pages[] 可能落后于磁盘,照它判会把已有日记当新的再套一遍模板。
  const existed = (await amadeus.readTextFile(path).catch(() => null)) != null
  if (!existed) {
    // 素文件出生(与 createPageInFolder 同规)。老路 openOrCreate → 主进程 newPage 生的是 v3
    // (amadeus_page + 块标记),而「打开即升」默认开 → 路由当场把它交给 UnifiedPage,模板往
    // 交出去的 v3 store 里写,写完即被冲掉:日记建出来但一个字都没有(2026-08-21 真机实测)。
    await amadeus.writeTextFile(path, '')
    await ps().refreshStructure()
  }
  await openNote(path) // 内部等就绪:v3 等 activePage,v4 等 unified 实例登记
  if (existed) return
  const daily = ps().pages.find((p) => /^templates\/daily\.md$/i.test(p))
  if (!daily) return
  // 模板读取失败(被删等)不影响日记本体。
  await insertTemplate(daily, { v4Path: path }).catch(() => { /* ignore */ })
}
