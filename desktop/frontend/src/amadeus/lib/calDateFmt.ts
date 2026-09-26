// fmtCalDate 的渲染层包装:把「月日」文案接上 i18n。
// 为什么要包一层:calDate.ts 住在 shared/(server 与引擎也 import 它),不能依赖渲染层的 i18n ——
// 所以那边留了 MdFormatter 参数,这里把当前语言的实现塞进去。渲染层一律用本文件的 fmtCalDateL。
// en 取 `9/3` 而不是 `Sep 3`:与日历表头现有的 `9/1` 同一套写法,窄芯片里也不撑宽。
import { registerMessages, translate } from '../../i18n'
import { fmtCalDate, type CalDate } from '@amadeus-shared/db/calDate'

registerMessages({
  'caldate.md': { zh: '{m}月{d}日', en: '{m}/{d}' },
  // 带年份(Codex 第三轮 R2-e2-1):列表里跨年 / 不同年份同月同日的条目要分得开(如 Muse 的追踪日程)。
  'caldate.ymd': { zh: '{y}年{m}月{d}日', en: '{m}/{d}/{y}' },
})

export const fmtCalDateL = (c: CalDate | null): string =>
  fmtCalDate(c, (m, d) => translate('caldate.md', { m, d }))

/** 同 fmtCalDateL,但每侧都带年份:`2027年1月5日 09:00` / `1/5/2027 09:00`。给跨年也要分得开的列表用。 */
export const fmtCalDateYL = (c: CalDate | null): string =>
  fmtCalDate(c, (m, d, y) => translate('caldate.ymd', { y, m, d }))
