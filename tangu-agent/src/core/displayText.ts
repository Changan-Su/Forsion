/**
 * 展示用文本净化:工具参数派生的预览 / 规则名 / 模型终稿要进 LOG 行、收件箱标题、Journal 行时,
 * 必须先过这一道 —— 换行能伪造出一条新的 `[approval] approved …` 记录,C0/bidi 控制符能把
 * 「rm -rf /」显示成别的东西。原始参数只留在执行字段(args),永不进展示面。
 */
// C0 控制符 + DEL + 零宽/方向控制(U+200E/F, U+202A-U+202E, U+2066-U+2069)。
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function displayText(s: unknown, max = 300): string {
  return String(s ?? '').replace(CONTROL_AND_BIDI, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
