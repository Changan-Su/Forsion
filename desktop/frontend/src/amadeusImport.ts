// 拖入 / 粘贴 / 上传的统一文件导入。三端多态:直接调 window.amadeus.saveAttachment/saveAsset
// (本地磁盘 / 云端 HTTP / 移动 FS 各自实现),调用方不分本地云端。云端直写才预检 5MB 上限。
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { getAttachmentPrefs } from '@amadeus/lib/attachments'
import { useUiStore } from '@amadeus/store/uiStore'
import { b64ToBytes } from './services/fileKinds'

// 云 vault 单文件上限(server vaultService MAX_BINARY_BYTES = 5MiB);本地磁盘库无此限,不预检。
const CLOUD_MAX_BYTES = 5 * 1024 * 1024

const ps = () => usePageStore.getState()
// amadeus 语境吐司走 uiStore(AmadeusOverlays 在主窗与独立窗都渲染;单条即时替换,多文件不刷屏)。
const notify = (text: string): void => useUiStore.getState().notify(text)

/** 当前 saveAttachment/saveAsset 是否直接写云端 HTTP(服务端 5MB 闸即时生效)。
 *  桌面(有 amadeusSync):仅云侧——本地侧先落盘、由同步引擎稍后推,不在此刻受限;
 *  web / 移动云端(cloudBridge 设了 amadeusCloudVaults):直连受限;移动本地(无该对象):不受限。 */
function isCloudDirectWrite(): boolean {
  // amadeusCloudVaults 由 cloudBridge 经 cast 挂到 window(未在 Window 类型上声明),同 amadeusViews 取法。
  return window.amadeusSync ? ps().vaultSide === 'cloud' : !!(window as { amadeusCloudVaults?: unknown }).amadeusCloudVaults
}

/** 关预览的附件链接;含空格/括号的路径包 `<>`(名字里的 `[]` 去掉)。 */
function mdLink(name: string, rel: string): string {
  const dest = /[ ()<>]/.test(rel) ? `<${rel}>` : rel
  return `[${name.replace(/[[\]]/g, '')}](${dest})`
}

/** 预览嵌入 ![[base]] 会被 `]` / `|`(宽度分隔)/ `#` 破坏 → 这类文件名回落到 [名](相对路径)。 */
function embedOrLink(base: string, name: string, pageRel: string, preview: boolean): string {
  return preview && !/[[\]|#]/.test(base) ? `![[${base}]]` : mdLink(name, pageRel)
}

/** 把服务端/本地错误折成用户能懂的一句话。 */
function explain(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  if (/TOO_LARGE|\b413\b/.test(s)) return '超过云端单文件上限 5MB'
  if (/VAULT_FULL/.test(s)) return '云端库容量已满'
  return s || '未知错误'
}

/** 云端直写才卡 5MB(本地/移动本地无限)。返回被跳过的原因串,或 null=放行。 */
function overLimit(f: File): string | null {
  return isCloudDirectWrite() && f.size > CLOUD_MAX_BYTES ? '超 5MB' : null
}

async function refreshTree(): Promise<void> {
  try { await ps().refreshStructure?.() } catch { /* 刷新失败不致命 */ }
}

/** 上传进度吐司(云端 XHR 才回调;本地磁盘瞬时,不触发)。pct 整数变化才刷,progress 事件很密。 */
function progressNotifier(name: string): (sent: number, total: number) => void {
  let last = -1
  return (sent, total) => {
    const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0
    if (pct !== last) { last = pct; notify(`正在上传 ${name}… ${pct}%`) }
  }
}

/** 正文占位:上传开始就插「⏳ 上传中」块,完成后原地替换 / 失败改成失败标记。只在仍是原页、
 *  块还在、且**内容仍是占位文本**时才动它——切页后 blocks 已是新页集合(直接 set 造幽灵块);
 *  BlockId 是 max+1 复用的,用户删掉尾部占位再插新块会拿到同一 id,内容校验挡住误覆盖。
 *  失败不走 deleteBlock:它内部 await 云端 backlinks、await 前捕获的旧 manifest 会在切页后混页提交;
 *  同步 setBlockContent 无竞态,失败标记留正文用户可见可手删。
 *  ponytail: 占位插入/替换是两步 undo(完成后 undo 一次回到 ⏳ 文本),pageStore 无免历史突变,不值得加;
 *  切页场景占位行随自动保存留在原页,由吐司提示,不做跨页读改写回收。 */
function placeholder(page: string, name: string): { done(text: string): boolean; fail(): void } {
  const marker = `⏳ 正在上传 ${name}…`
  const pid = ps().activePage === page ? ps().insertBlockAfter(null, undefined, marker) : null
  const alive = (): boolean => !!pid && ps().activePage === page && ps().blocks[pid!]?.content === marker
  return {
    // false = 占位已不可替换(切了页,或用户删/改了占位——后者尊重用户操作,不再硬插)。
    done: (text) => { if (!alive()) return false; ps().setBlockContent(pid!, text); return true },
    fail: () => { if (alive()) ps().setBlockContent(pid!, `⚠️ 上传失败:${name}`) },
  }
}

/** 拖入 / 上传到当前笔记:存到配置的附件位置 + 插入 ![[嵌入]] 或 [名](相对路径)。 */
export async function importToPage(files: File[], page: string): Promise<void> {
  if (!files.length || !page) return
  const { opts, preview } = await getAttachmentPrefs()
  let ok = 0
  let movedAway = 0 // 上传期间用户切了笔记:文件已存入原页,但不误插到当前别的笔记
  const fails: string[] = []
  for (const f of files) {
    const over = overLimit(f)
    if (over) { fails.push(`${f.name}(${over})`); continue }
    const ph = placeholder(page, f.name)
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const { pageRel, base } = await amadeus.saveAttachment(page, f.name, bytes, opts, progressNotifier(f.name))
      // 占位原地换成真实引用;占位被用户删了 = 尊重删除(文件已在库,树里可见);切页才计 movedAway。
      if (ph.done(embedOrLink(base, f.name, pageRel, preview)) || ps().activePage === page) ok++
      else movedAway++
    } catch (e) { ph.fail(); fails.push(`${f.name}(${explain(e)})`) }
  }
  await refreshTree()
  if (fails.length) notify(`${fails.length} 个文件未导入:${fails[0]}`)
  else if (movedAway) notify(`文件已存入原笔记(已切换页,占位行未替换)`)
  else notify(files.length > 1 ? `已导入 ${ok} 个文件` : `已上传 ${files[0].name}`)
}

/** 拖到文件树 / 库侧栏:把文件写进库里的目标文件夹(空串=库根,不插入嵌入),类似文件管理器导入。 */
export async function importToFolder(files: File[], folder: string): Promise<void> {
  if (!files.length) return
  let ok = 0
  const fails: string[] = []
  for (const f of files) {
    const over = overLimit(f)
    if (over) { fails.push(`${f.name}(${over})`); continue }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      await amadeus.saveAttachment('', f.name, bytes, { mode: 'vault', folder }, progressNotifier(f.name))
      ok++
    } catch (e) { fails.push(`${f.name}(${explain(e)})`) }
  }
  await refreshTree()
  const where = folder ? (folder.split('/').pop() || folder) : '库根目录'
  if (fails.length) notify(`${fails.length} 个文件未导入:${fails[0]}`)
  else notify(`已导入 ${ok} 个文件到「${where}」`)
}

/** 应用内路径拖拽(文件面板的行)要走进「导入」这条链,得先把主机文件读成 File —— 主进程
 *  `fs:readFile` 给 base64(>50MB 只回 tooLarge,不读)。读不动的逐个报名字,不整批失败。
 *  ponytail: 逐个串行读,拖十几个文件的量级不值得并发。 */
export async function filesFromHostPaths(paths: string[]): Promise<File[]> {
  const read = window.tangu?.readHostFile
  if (!read) return []
  const out: File[] = []
  const fails: string[] = []
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() || p
    try {
      const r = await read(p)
      if (!r || r.tooLarge) { fails.push(`${name}(${r?.tooLarge ? '超 50MB' : '读不到'})`); continue }
      out.push(new File([b64ToBytes(r.content) as unknown as BlobPart], name, { type: r.mimeType }))
    } catch (e) { fails.push(`${name}(${explain(e)})`) }
  }
  if (fails.length) notify(`${fails.length} 个文件读不了:${fails[0]}`)
  return out
}

/** 粘贴图片:存 .amadeus/ 并以规范 markdown 图片形式插入。用 ![](.amadeus/x.png) 而非 ![[…]]:
 *  这是磁盘规范形式,assets.ts joinRel/toDisplayMarkdown 必解析;名字空格会破坏 IMG_RE,入库前清洗。 */
export async function pasteImagesToPage(imgs: File[], page: string): Promise<void> {
  if (!imgs.length || !page) return
  let movedAway = 0
  const fails: string[] = []
  for (const f of imgs) {
    if (overLimit(f)) { fails.push('图片超 5MB'); continue }
    const name = (f.name || 'pasted.png').replace(/\s+/g, '_')
    const ph = placeholder(page, name)
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const rel = await amadeus.saveAsset(page, name, bytes, progressNotifier(name)) // → ".amadeus/<unique>"(页相对)
      // 占位原地换成图片;占位被用户删了 = 尊重删除(图片已存原页 .amadeus/);切页才计 movedAway。
      if (!ph.done(`![](${rel})`) && ps().activePage !== page) movedAway++
    } catch (e) { ph.fail(); fails.push(explain(e)) }
  }
  await refreshTree()
  if (fails.length) notify(`粘贴图片:${fails[0]}`)
  else if (movedAway) notify('图片已存入原笔记(已切换页,占位行未替换)')
}
