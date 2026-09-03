// fmtCalDate 的渲染层包装:把「月日」文案接上 i18n。
// 为什么要包一层:calDate.ts 住在 shared/(server 与引擎也 import 它),不能依赖渲染层的 i18n ——
// 所以那边留了 MdFormatter 参数,这里把当前语言的实现塞进去。渲染层一律用本文件的 fmtCalDateL。
// en 取 `9/3` 而不是 `Sep 3`:与日历表头现有的 `9/1` 同一套写法,窄芯片里也不撑宽。
import { registerMessages, translate } from '../../i18n'
import { fmtCalDate, type CalDate } from '@amadeus-shared/db/calDate'

registerMessages({
  'caldate.md': { zh: '{m}月{d}日', en: '{m}/{d}' },
})

export const fmtCalDateL = (c: CalDate | null): string =>
  fmtCalDate(c, (m, d) => translate('caldate.md', { m, d }))
