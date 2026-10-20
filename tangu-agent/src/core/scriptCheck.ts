/**
 * 产出的语言核对(10-20):Historian 用的模型有把英文对话写成中文的先验 —— 判官输入一个汉字都没有,
 * 也会写出中文摘要 / 标题(台架 titlelang 实测约一半),提示词压不住,只能产出后在代码里核。
 * 按书写系统粗分(中日汉字与假名算一类),只拦一种情形:产出的主书写系统在用户自己的话里一个字都没出现。
 * 中文里夹英文术语这类混写两边都放行。
 * ponytail: 只分书写系统、不分语言 —— 英文对话被写成西班牙语拦不住;要分再接语言识别。
 */
const FAMILIES: Array<[string, RegExp]> = [
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
];

function familyCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of String(text || '').match(/\p{L}/gu) || []) {
    const f = FAMILIES.find(([, re]) => re.test(ch))?.[0] ?? 'other';
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return counts;
}

/** true = text 的主书写系统在 userText 里一个字都没有。任一边没有字母(只发了图 / 符号)→ 不判。 */
export function offScript(text: string, userText: string): boolean {
  const main = [...familyCounts(text)].sort((a, b) => b[1] - a[1])[0]?.[0];
  const user = familyCounts(userText);
  return !!main && user.size > 0 && !user.has(main);
}
