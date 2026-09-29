// D-19(评审 2026-09-27):CRLF 笔记按原行尾写回(对标 VS Code「按文件保持原 EOL」)。
//
// 病:v4 整篇重新序列化只会写 `\n`,CRLF 笔记第一次编辑就整篇转成 LF(git diff 整篇抖动,Windows 协作者那边整篇变更)。
// 修法:**只在磁盘 I/O 边界**转换 —— 读进来(打开 / 回灌 / CAS 拒写回的现文)纯 CRLF 的归一成 LF 并记下行尾,
// 写出去(writeTextFile 的正文与 CAS 基线指纹)按记下的行尾还原。内存(pipe.fm / body / lastSaved、编辑器、草稿)一律 LF,
// 所以编辑器、D-18 逐字回填、fm 行级改写都不必认识 `\r`。
// 只认**纯** CRLF(每个换行都是 `\r\n`、没有孤立的 `\r`):混杂的文件维持原行为(按原样喂编辑器,写出 LF)——
// 猜不准的时候不替用户改行尾。
// ⚠️ CAS 基线必须是**磁盘字节**的指纹(toDisk(lastSaved)),否则每次写都被拒、回灌 / 冲突副本循环。
export type Eol = '\n' | '\r\n'

/** 纯 CRLF → '\r\n';其余(纯 LF、混杂、没有换行)→ '\n'。 */
export function eolOf(text: string): Eol {
  const crlf = text.split('\r\n').length - 1
  if (!crlf) return '\n'
  return crlf === text.split('\n').length - 1 && crlf === text.split('\r').length - 1 ? '\r\n' : '\n'
}

/** 磁盘原文 → 内存(LF)+ 该文件的行尾。 */
export function fromDisk(text: string): { text: string; eol: Eol } {
  const eol = eolOf(text)
  return { text: eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text, eol }
}

/** 内存(LF)→ 磁盘原文。 */
export function toDisk(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
}
