/** 新建一篇笔记的两个小件:从 Markdown 首个标题取文件名、只新建不覆盖地落盘。只碰 Amadeus 的文件接口,
 *  界面热更新 3d 从 Tangu 的 chatToNote 挪回宿主(手机分享进来的文字也用,宿主不再直引 Tangu 模块)。 */
import { amadeus } from './api'
import { textFingerprint } from '@amadeus-shared/writeConflict'

/** 模型给的 markdown → { 标题, 正文 }:首个一级标题当文件名并从正文剥掉;没有就用 fallback。 */
export function splitNoteTitle(md: string, fallback: string): { title: string; body: string } {
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(md)
  const raw = m ? m[1] : fallback
  const title = raw.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback
  return { title, body: (m ? md.slice(m[0].length) : md).replace(/^\s*\n/, '') }
}

/** 只新建、不覆盖(create:true = 宿主原子的仅新建);重名依次试 `-2`…`-20`。返回落盘路径,全被占 → null。
 *  Tangu 的「对话转笔记」与手机的「分享到 Forsion → 存为笔记」(mobile/src/shareInbox.tsx)共用。 */
export async function writeFresh(title: string, md: string): Promise<string | null> {
  for (let n = 1; n <= 20; n++) {
    const path = `${n === 1 ? title : `${title}-${n}`}.md`
    if ((await amadeus.readTextFile?.(path)?.catch(() => null)) != null) continue
    const r = await amadeus.writeTextFile(path, md, { create: true, base: textFingerprint('') })
    if (r && r.ok === false) continue
    return path
  }
  return null
}
