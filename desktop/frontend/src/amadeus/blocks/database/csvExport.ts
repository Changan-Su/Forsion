/** 「导出 CSV」的渲染层逻辑:把**当前视图看到的那张表**(可见列 × 已筛选/排序的行)折成字符串矩阵,
 *  再交给 shared/db/csv.ts 的纯函数转义。住渲染层是因为「一格显示成什么」要 resolveBaseType(认插件
 *  注册的属性类型)、关联列要目标库 —— 这两样 shared 侧都没有。
 *
 *  口径(测试逐条钉住,改了先改 csvExport.test.ts):
 *   - **所见即所得**:计算列(公式/引用)取物化后的显示值;数字列走 numberFormat(配了 ¥/小数位就带上)。
 *     代价是配过格式的列在表格软件里是**文本**(带千分位逗号和单位)—— 想要纯数字就别给那列配格式。
 *   - 多值(rowlink / 多附件 / 多选)一律 `, ` 展平在一格里,靠 RFC 4180 的引号包住,不拆成多列。
 *   - checkbox → `TRUE`/`FALSE`(表格软件通用,能被再导入回来;`✓`/空 看着好看但不可逆)。
 *
 *  ⚠️ 落盘那一步是 **host 门控**:桌面走主进程保存对话框(IPC),web 退化成浏览器下载,移动端整个按钮
 *     不出现(WebView 里 `<a download>` 不可靠,留个点了没反应的按钮比没有更糟)。门控写在本文件里,
 *     已登记进 scripts/platform-parity.check.cjs 的 GATE_FILES + KNOWN_GATES。 */
import { toCsv, withBom } from '@amadeus-shared/db/csv'
import { fileRefs } from '@amadeus-shared/db/fileCell'
import { formatNumber } from '@amadeus-shared/db/numberFormat'
import { coerceForDisplay, type CellValue, type DbColumn, type DbFile, type DbRow } from '@amadeus-shared/db/schema'
import { isLinksProjection } from '@amadeus-shared/db/backlink'
import { resolveBaseType } from './propertyTypes'
import { isComputedCol, linkLabel, rowLinkIds } from './rowLink'

/** 关联列取目标库(DatabaseEmbed 的 refDbByPath;没加载到 → null,芯片退回行 id)。 */
export interface CsvCtx {
  targetDb(refDb: string): DbFile | null
}

/** 多值展平的分隔符:与表格里芯片并排的观感一致;含逗号的字段由 csvField 加引号兜住。 */
const MULTI_SEP = ', '

/** 一格 → 显示串(空 = '')。 */
export function csvCellText(row: DbRow, col: DbColumn, ctx: CsvCtx): string {
  const raw = row.cells[col.id]
  // 关联表列 / 可编辑投影列:芯片文案(titleCol 指定列),不是行 id
  if (col.type === 'rowlink' || isLinksProjection(col)) {
    const t = col.refDb ? ctx.targetDb(col.refDb) : null
    return rowLinkIds(raw)
      .map((id) => {
        const hit = t?.rows.find((x) => x.id === id)
        return hit && t ? linkLabel(t, hit, col.titleCol) : id // 目标库没到 / 行已删 → 退回 id,不是空格子
      })
      .join(MULTI_SEP)
  }
  if (col.type === 'file') return fileRefs(raw).join(MULTI_SEP)
  // 计算列:物化值(数字照列配置格式化,别让 ¥ 只在屏幕上有)
  if (isComputedCol(col.type)) {
    if (raw == null) return ''
    if (typeof raw === 'number') return formatNumber(raw, col)
    return Array.isArray(raw) ? raw.join(MULTI_SEP) : typeof raw === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : String(raw)
  }
  // ponytail: 属性注册表没有「值 → 文本」钩子,自动编号的前缀在这里特判(与 rowLink.linkLabel 同款)
  if (col.type === 'autonumber' && typeof raw === 'number') return `${col.prefix ?? ''}${raw}`
  // created / updated 落盘是 `YYYY-MM-DDTHH:mm`,屏幕上把 T 换成空格,导出跟着走
  if ((col.type === 'created' || col.type === 'updated') && typeof raw === 'string') return raw.replace('T', ' ')
  const base = resolveBaseType(col.type)
  const v: CellValue = coerceForDisplay(raw, base)
  if (base === 'checkbox') return v === true ? 'TRUE' : 'FALSE'
  if (base === 'number') return formatNumber(v, col)
  return Array.isArray(v) ? v.join(MULTI_SEP) : v == null ? '' : String(v)
}

/** 可见列 × 已筛选行 → 字符串矩阵(首行 = 列名)。 */
export function csvMatrix(cols: DbColumn[], rows: DbRow[], ctx: CsvCtx): string[][] {
  return [cols.map((c) => c.name), ...rows.map((r) => cols.map((c) => csvCellText(r, c, ctx)))]
}

/** 可见列 × 已筛选行 → CSV 文本(**不带 BOM**;BOM 在落盘/下载那一层加)。 */
export const buildDbCsv = (cols: DbColumn[], rows: DbRow[], ctx: CsvCtx): string =>
  toCsv(csvMatrix(cols, rows, ctx))

/** 文件名清洗(与主进程 exportPdf 的 defaultPath 同款:去掉路径与保留字符)。 */
export const csvFileName = (name: string): string =>
  (name || 'database').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'database'

/** 本端怎么导出:
 *   - `'host'` = Electron 主进程保存对话框(真桌面);
 *   - `'download'` = 浏览器下载(Tangu Web / 台架);
 *   - `'off'`  = 移动端,按钮**不渲染**(Capacitor WebView 里 `<a download>` 不落盘)。
 *  ⚠️ 这里的 `window.amadeus?.exportCsv` / `window.tangu?.mobile` 两处字面量是 check:parity 的门控台账
 *     扫到的东西(GATE_FILES),别改写成别名或解构 —— 改了台账就抓不到「移动端静默少功能」。 */
export function csvExportMode(): 'host' | 'download' | 'off' {
  if (typeof window === 'undefined') return 'off'
  if (typeof window.amadeus?.exportCsv === 'function') return 'host'
  return window.tangu?.mobile ? 'off' : 'download'
}

/** 导出一次。host 走 IPC 保存对话框(返回保存路径 / 用户取消 = null);web 走 Blob 下载(恒返回 null)。 */
export async function exportCsvFile(baseName: string, csv: string): Promise<string | null> {
  const text = withBom(csv)
  const name = csvFileName(baseName)
  if (typeof window.amadeus?.exportCsv === 'function') return window.amadeus.exportCsv(name, text)
  // 浏览器下载兜底:type 带 charset 免得某些浏览器按 latin-1 猜
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.csv`
  a.click()
  // revoke 押后:同步 revoke 会赶在下载真正开始之前,Safari 上直接下出空文件
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return null
}
