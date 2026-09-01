// 写一份 vault 文本文件,并让索引跟着新鲜 —— **成对**的两件事,别再分开写。
//
// 2026-08-31 用户实报「笔记图标有时候在工作区莫名其妙不显示」的真因就在这条缝上:
// v3 笔记走 savePage(那边紧跟着 index.update),而 **v4/unified 笔记的唯一落盘通道是
// `IPC.writeTextFile`**,它只写盘不更索引;watcher 又按自写账本压掉自己的回声(那条压制是
// 对的,别去动它 —— 不压就是每次自动保存全库重索引)。于是索引里那条目一直停在**上次启动**
// 时的样子:`pageIcons()` 取不到新图标(侧栏/树/双链补全的 emoji 全空)、全文搜索搜不到新写的
// 内容、反链与 tags 同样陈旧,直到重启应用才「莫名其妙又好了」。
//
// ⚠️ 判据走 `vault.isPagePath`(与 listPages 同一份):画板 `.excalidraw.md`、插件声明的文件类型
//    `.mindmap.md` 磁盘上虽是 .md 却不是笔记,进索引就会被当页面解析。
// ponytail: 代价 = 每次防抖保存多一次「读回 + 解析」。v3 的 savePage 一直是这个量级,不是新账。
import type { VaultManager } from './vaultManager'
import type { VaultIndex } from './vaultIndex'

export async function writeVaultText(
  vault: VaultManager,
  index: VaultIndex,
  rel: string,
  text: string,
): Promise<void> {
  await vault.writeTextFile(rel, text)
  if (vault.isPagePath(rel)) await index.update(rel)
}
