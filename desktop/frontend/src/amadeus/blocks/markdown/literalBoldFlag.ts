// Hidden switch for "bold delimiters are real text characters" (see ./literalBold).
// Off by default and not in Settings. Read once per page load: URL `?litbold=1` or localStorage `amx.literalBold` = '1'.
// The editor builds its plugins from this value, so it must not change while notes are open (a note read with the
// switch on is plain text with `**`; serialising it with the switch off would escape them).
// 隐藏开关「加粗定界符是正文里的真字符」。缺省关、不进设置页;页面加载时读一次(网址 `?litbold=1` 或
// localStorage `amx.literalBold` = '1')。读写两侧都按这一个值走,打开着的笔记期间不能变。
let cached: boolean | null = null
let override: boolean | null = null

/** Tests only: force the switch (null = back to the page value). 仅测试用。 */
export function setLiteralBold(v: boolean | null): void {
  override = v
}

function readOnce(): boolean {
  try {
    if (typeof location !== 'undefined' && /[?&]litbold=1(?:&|$)/.test(location.search)) return true
    if (typeof localStorage !== 'undefined' && localStorage.getItem('amx.literalBold') === '1') return true
  } catch {
    /* storage blocked: off */
  }
  return false
}

export function literalBoldEnabled(): boolean {
  if (override != null) return override
  if (cached == null) cached = readOnce()
  return cached
}
