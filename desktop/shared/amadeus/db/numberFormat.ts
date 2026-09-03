/** 数字列的**显示格式化**(纯渲染层,绝不改落盘值):小数位 precision + 单位前后缀。
 *  落盘恒为纯数字(schema.CellValue 的 number),这里只负责「怎么显示给人看」——
 *  所以进入编辑态必须回到原始值(见 DatabaseEmbed 的 number 分支),否则用户一点就把
 *  「¥1,234.00元」当成新值存回去了。
 *
 *  ⚠️ **opt-in**:三个字段一个都没配 = 原样 `String(n)`,与格式化落地前逐字节相同。
 *     这条不是优化而是正确性 —— 全表默认加千分位会让既有仪器(erp.check E3 断言 `'112000'`)
 *     与用户既有观感一起变,且「没配过格式的列突然多出逗号」本身就是 bug。
 *
 *  渲染层与公开分享页共用;不在 tangu-agent/scripts/sync-db-shared.mjs 的 FILES 表里(引擎不渲染)。 */
import type { CellValue } from './schema'

/** 列上与数字格式相关的三个字段(DbColumn 的子集;调用方直接传整列即可)。 */
export interface NumberFormatSpec {
  /** 小数位 0-6;缺 = 跟随原值(不补零、不截断)。 */
  precision?: number
  /** 单位前缀,如 `¥`。 */
  unitPrefix?: string
  /** 单位后缀,如 `元` / `%` / `台`。 */
  unitSuffix?: string
}

/** 本列配过格式吗(空串前后缀视为没配:清空输入框 = 关掉该缀)。 */
export const hasNumberFormat = (c: NumberFormatSpec | undefined | null): boolean =>
  !!c && (c.precision !== undefined || !!c.unitPrefix || !!c.unitSuffix)

/** precision 的合法区间(schema 的 zod 与列菜单输入框同用这两个边界)。 */
export const PRECISION_MIN = 0
export const PRECISION_MAX = 6

/** 夹到 [0,6] 的整数;非法(NaN/非有限)→ undefined(= 不设小数位)。 */
export const clampPrecision = (n: number | undefined): number | undefined => {
  if (n === undefined || !Number.isFinite(n)) return undefined
  return Math.min(PRECISION_MAX, Math.max(PRECISION_MIN, Math.trunc(n)))
}

/** 数值主体(不含单位):千分位 + 定小数位。
 *  - 走 Intl.NumberFormat('en-US'):Node(vitest)与 Chromium(台架)共用 ICU,两边输出逐字相同。
 *  - precision 缺省时 maximumFractionDigits 顶到 20 —— Intl 默认只有 3 位,不显式拉高会把
 *    1.23456 静默截成 1.235(「只配了单位」的列凭空丢精度)。
 *  - **负零归一**:-0.001 保留 2 位数学上是 -0.00,给人看没有意义(还会让 CSV 里出现 `-0.00`),
 *    统一抹掉符号。 */
const bodyOf = (n: number, precision: number | undefined): string => {
  const p = clampPrecision(precision)
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: p ?? 0,
    maximumFractionDigits: p ?? 20,
    useGrouping: true,
  }).format(Math.abs(n))
}

/** 单元格值 → 显示串。
 *  - number(有限)→ 按 spec 格式化;没配格式 = `String(n)` 原样。
 *  - null / undefined / '' → `''`(空值不显示 `¥0.00`:那是「有个 0」和「没填」的混淆)。
 *  - 非数字(字符串脏值 / 布尔 / 数组)→ **原样**(列类型切换是非破坏式的,格式化不该吃掉旧数据)。
 *  符号位置:`-¥1,234.00元` —— 负号在最外层,读法与手写一致(`¥-1234` 那种夹在中间的写法只在
 *  会计红字里出现,这里不做那套)。前后缀与数字**不加空格**:`%` / `元` 都不该有空格,要空格自己写进后缀串。 */
export function formatNumber(v: CellValue | undefined, spec?: NumberFormatSpec | null): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v !== 'number' || !Number.isFinite(v)) return Array.isArray(v) ? v.join(', ') : String(v)
  if (!hasNumberFormat(spec)) return String(v)
  const body = bodyOf(v, spec?.precision)
  // 四舍五入到 0 之后就不是负数了(-0.001 @p=2 → 0.00,不是 -0.00)
  const neg = v < 0 && /[1-9]/.test(body)
  return `${neg ? '-' : ''}${spec?.unitPrefix ?? ''}${body}${spec?.unitSuffix ?? ''}`
}
