// compile(): in-memory manifest + per-block content -> the portable note file `abc.md`.
// Frontmatter carries the note id + the 2D layout (compact JSON). The body is plain,
// readable markdown: each block opens with a `<!-- a <id> -->` marker (invisible in
// Obsidian) followed by its content, in reading order. Content is written exactly once.

import { serializeLayout } from './manifest'
import { blockMarker } from './markers'
import { AMADEUS_FM_KEY } from './split'
import type { BlockId, PageManifest } from './types'

/** Highest numeric block id placed in the layout, +1 (= the derivable next id). */
function derivedNextId(m: PageManifest): number {
  let max = 0
  for (const row of m.root.children)
    for (const col of row.columns)
      for (const ref of col.children) {
        const n = Number.parseInt(ref.ref, 10)
        if (Number.isInteger(n) && String(n) === ref.ref && n > max) max = n
      }
  return max + 1
}

function frontmatter(m: PageManifest): string {
  // 外来 frontmatter(Obsidian properties 等)原文回写——丢弃即数据损失。
  // 在写盘咽喉过滤保留键与裸 '---' 行:属性面板原文模式等任何写入方都可能夹带,
  // 一旦落盘会劫持 amadeus_page/提早闭合 frontmatter,直接破坏文件结构。
  const extra = (m.fmExtra ?? '')
    .split('\n')
    .filter((l) => !AMADEUS_FM_KEY.test(l) && !/^---\s*$/.test(l))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
  // 高水位只在携带信息时落盘(> 可推导值,即最高号块被删过),平时不加行。
  const derived = derivedNextId(m)
  const highWater = Math.max(m.nextId ?? 0, derived)
  return [
    '---',
    `amadeus_page: ${m.id}`,
    `amadeus_schema: ${m.schema}`,
    `amadeus_layout: ${serializeLayout(m.root)}`,
    ...(highWater > derived ? [`amadeus_next_id: ${highWater}`] : []),
    ...(extra ? [extra] : []),
    '---',
  ].join('\n')
}

export function compile(manifest: PageManifest, contents: Record<BlockId, string>): string {
  // 版本闸:amadeus_schema 声明的 major 比本编译器新 → 拒写。旧客户端「打开即修复」会把
  // 未来格式静默改写回 v3(重编号+重排),这是唯一挡在所有写入路径(desktop/web 源码模式)前的咽喉。
  if (manifest.schemaTooNew) {
    throw new Error('amadeus: 笔记由更新版本的格式写入(amadeus_schema 超出本端支持),已拒绝改写以防损坏')
  }
  const segments: string[] = [frontmatter(manifest)]
  for (const row of manifest.root.children) {
    for (const col of row.columns) {
      for (const ref of col.children) {
        // 保住块首行首横向空白(段落缩进档=行首制表符,indentIo,2026-08-14):裸 .trim() 会抹缩进。
        // trimEnd 而非 /\s+$/(长空白 run 二次方回溯,评审 P1);\r? 防 CRLF 垃圾前缀。
        const content = (contents[ref.ref] ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
        segments.push(content ? `${blockMarker(ref.ref)}\n\n${content}` : blockMarker(ref.ref))
      }
    }
  }
  return segments.join('\n\n') + '\n'
}
