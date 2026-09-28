/** 正文计数(评审 C-22)。只管「一段已经是可见文字的串」怎么数,取可见文字是调用方的事(v4 见 unified/noteStats)。
 *  · 字 = 非空白字符,按码点数(emoji 算一个,不按 UTF-16 码元);
 *  · 词 = 中文 / 日文假名每个字符各算一词(没有空格分词,Obsidian 同口径)+ 其余文字按字母数字串切词
 *    (`don't`、`e-mail` 算一个;韩文按空格分词,归后者)。 */
export interface TextCount { chars: number; words: number }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

export function countText(s: string): TextCount {
  const cjk = s.match(CJK)?.length ?? 0
  const words = s.replace(CJK, ' ').match(WORD)?.length ?? 0
  let chars = 0
  for (const ch of s) if (!/\s/.test(ch)) chars++
  return { chars, words: cjk + words }
}
