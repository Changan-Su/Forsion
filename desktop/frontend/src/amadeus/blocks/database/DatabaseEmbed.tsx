/** Database 嵌入(![[xxx.db]]):Notion 式可编辑表格,数据存 vault 内独立 .db JSON 文件。
 *  数据经 dbStore 按 ref 共享 → 同一 db 的多处嵌入(同页多块/多标签)实时互通、写穿防抖落盘。
 *  排序仅视图态不写盘(文件 rows 顺序即规范顺序);列类型切换非破坏(coerceForDisplay 宽容显示)。
 *  弹层(选项/列菜单)用 fixed 定位:表格外层是 overflow 滚动层,absolute 会被裁剪。 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  COLUMN_TYPES,
  DEFAULT_DB_VIEW,
  coerceForDisplay,
  dbId,
  sortsOf,
  viewsOf,
  type CellValue,
  type ColumnType,
  type DbColumn,
  type DbFile,
  type DbRow,
  type DbView,
  type DbViewFilter,
  type DbViewForm,
  type DbViewGantt,
  type DbViewType,
} from '@amadeus-shared/db/schema'
import { FILTER_OPS, OP_LABEL, STAT_LABEL, UNARY_OPS, applyFilters, applySorts, computeStat, statOptionsFor } from '@amadeus-shared/db/viewQuery'
import { evalRowFormulas, todayStr } from '@amadeus-shared/db/formula'
import { computeRowLookups, isBackLookup } from '@amadeus-shared/db/lookup'
import { backLinkEdit, backLinkSet, isLinksProjection, projectionIssue } from '@amadeus-shared/db/backlink'
import { orderColumns } from '@amadeus-shared/db/viewCols'
import { formatNumber, hasNumberFormat, PRECISION_MAX, PRECISION_MIN } from '@amadeus-shared/db/numberFormat'
import { addFileRefs, fileRefs, removeFileAt } from '@amadeus-shared/db/fileCell'
import { buildDbCsv, csvExportMode, exportCsvFile } from './csvExport'
import './cellFormat.css'
import { buildTree } from '@amadeus-shared/db/tree'
import { dateGroupUnitOf, groupRowsByDate, type DateGroupUnit } from '@amadeus-shared/db/groupDate'
import { joinRel, toAssetUrl } from '@amadeus-shared/assets'
import { useShallow } from 'zustand/react/shallow'
import { parseCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { fmtCalDateL } from '@amadeus/lib/calDateFmt'
import { deriveColumns, fmValueToCell } from '@amadeus-shared/db/pageFrontmatter'
import { allPropertyTypes, getPropertyType, isStamped, newRowCells, resolveBaseType, usePropertyTypesVersion } from './propertyTypes'
import { RelationPicker } from './propertyTypes.builtins'
import { linkTarget, resolvePageName } from '@amadeus-shared/links'
import { useDbStore } from '../../store/dbStore'
import { renameDb } from '../../lib/dbFileOps'
import { useNoteViewStore } from '../../store/noteViewStore'
import { usePageStore, useScopedPageStore } from '../../store/pageStore'
import { amadeus } from '../../api'
import { Settings2, ExternalLink, Plus, Paperclip, Sigma, Link2, ArrowRightLeft, ClipboardList, ChartGantt, ChevronRight, Download } from 'lucide-react'
import { openDb } from '../../../amadeusNav'
import { registerMessages, useI18n } from '../../../i18n'
import { useCalendarConfig, memberOf } from '../../store/calendarConfigStore'
import { MemberColPicker } from '../../../views/calendar/MemberColPicker'
import { act, actDebounced, shortVal } from '../../../activity/log'
import { OverlayAt } from '../../lib/clampMenu'
import { dropAfter, dropAfterX, moveColumn, moveRow, sameOrder } from './rowOrder'
import { detachLookups, dropSelfRefs, isComputedCol, linkLabel, normDbPath, resolveTreeCol, rowLinkIds, titleColOf, treeColsOf } from './rowLink'
import './treeBody.css'
import {
  ChartPanelIcon, CheckBoxCheckLinearIcon, DatabaseKanbanViewIcon, DatabaseListViewIcon, DatabaseTableViewIcon,
  DateTimeIcon, FilterIcon, FolderIcon, ImageIcon, LinkIcon, MultiSelectIcon, NumberIcon, PageIcon,
  PlusIcon, SingleSelectIcon, TextIcon, TodayIcon,
} from '../../components/icons'
import { ChartViewBody, resolveChartGroupCol } from './ChartBody'
import { FormBody, FormDefaultInput } from './FormBody'
import { GanttBody } from './GanttBody'
import { ganttDateCols, ganttScaleOf, resolveGanttCols } from './ganttLogic'
import { formFields } from './formLogic'
import { CHART_AGGS, CHART_KINDS, chartAggOf, chartKindOf } from '@amadeus-shared/dashboardData'

registerMessages({
  // 列类型 / 视图类型 / 聚合:模块级表只存**键**,文案在渲染时求值(写死字面量会冻在模块加载那一刻)
  'dbembed.type.text': { zh: '文本', en: 'Text' },
  'dbembed.type.number': { zh: '数字', en: 'Number' },
  'dbembed.type.checkbox': { zh: '勾选', en: 'Checkbox' },
  'dbembed.type.date': { zh: '日期', en: 'Date' },
  'dbembed.type.select': { zh: '单选', en: 'Select' },
  'dbembed.type.multiselect': { zh: '多选', en: 'Multi-select' },
  'dbembed.type.url': { zh: '链接', en: 'Link' },
  'dbembed.type.page': { zh: 'Page Name', en: 'Page name' },
  'dbembed.type.file': { zh: '附件', en: 'Attachment' },
  'dbembed.type.formula': { zh: '公式', en: 'Formula' },
  'dbembed.type.rowlink': { zh: '关联表', en: 'Relation' },
  'dbembed.type.lookup': { zh: '引用', en: 'Lookup' },
  'dbembed.view.table': { zh: '表格', en: 'Table' },
  'dbembed.view.kanban': { zh: '看板', en: 'Board' },
  'dbembed.view.calendar': { zh: '日历', en: 'Calendar' },
  'dbembed.view.gallery': { zh: '画廊', en: 'Gallery' },
  'dbembed.view.chart': { zh: '图表', en: 'Chart' },
  'dbembed.view.form': { zh: '表单', en: 'Form' },
  'dbembed.view.gantt': { zh: '甘特', en: 'Gantt' },
  'dbembed.agg.first': { zh: '首个', en: 'First' },
  'dbembed.agg.count': { zh: '计数', en: 'Count' },
  'dbembed.agg.sum': { zh: '求和', en: 'Sum' },
  'dbembed.agg.avg': { zh: '平均', en: 'Average' },
  'dbembed.agg.join': { zh: '拼接', en: 'Join' },
  'dbembed.chartKind.bar': { zh: '条形', en: 'Bar' },
  'dbembed.chartKind.line': { zh: '折线', en: 'Line' },
  'dbembed.chartKind.donut': { zh: '环形', en: 'Donut' },
  'dbembed.chartAgg.count': { zh: '计数行', en: 'Count rows' },
  'dbembed.chartAgg.sum': { zh: '求和', en: 'Sum' },
  'dbembed.chartAgg.avg': { zh: '平均', en: 'Average' },
  // 加载 / 损坏态
  'dbembed.loading': { zh: '读取数据库…', en: 'Loading database…' },
  'dbembed.missing': { zh: '数据库文件缺失:', en: 'Database file is missing: ' },
  'dbembed.retry': { zh: '重试', en: 'Retry' },
  'dbembed.corrupt': { zh: '数据库文件已损坏,已进入只读保护。', en: 'This database file is corrupted — it is now read-only.' },
  'dbembed.corruptDetail': { zh: '数据库文件已损坏({detail}),已进入只读保护。', en: 'This database file is corrupted ({detail}) — it is now read-only.' },
  'dbembed.reveal': { zh: '在文件管理器中显示', en: 'Show in file manager' },
  // 表头 / 工具栏
  'dbembed.namePlaceholderView': { zh: '未命名视图', en: 'Untitled view' },
  'dbembed.namePlaceholderDb': { zh: '未命名数据库', en: 'Untitled database' },
  'dbembed.folderPick': { zh: '选择数据来源文件夹(行 = 该文件夹里的笔记)', en: 'Choose the source folder (each row is a note inside it)' },
  'dbembed.wholeVault': { zh: '整库', en: 'Whole vault' },
  'dbembed.rowCount': { zh: '{n} 行', en: '{n} rows' },
  'dbembed.viewTabHint': { zh: '再次点击配置视图(改名/分组/删除)', en: 'Click again to configure this view (rename, group, delete)' },
  'dbembed.addView': { zh: '添加视图', en: 'Add view' },
  'dbembed.filter': { zh: '筛选', en: 'Filter' },
  'dbembed.filterThisView': { zh: '筛选(本视图)', en: 'Filter (this view)' },
  'dbembed.searchPlaceholder': { zh: '搜索…', en: 'Search…' },
  'dbembed.searchRows': { zh: '搜索行', en: 'Search rows' },
  'dbembed.openAsPage': { zh: '在新标签打开为页面', en: 'Open as a page in a new tab' },
  'dbembed.exportFail': { zh: '导出失败:{msg}', en: 'Export failed: {msg}' },
  'dbembed.exportCsv': { zh: '导出 CSV(当前视图 {cols} 列 × {rows} 行)', en: 'Export CSV ({cols} columns × {rows} rows in this view)' },
  'dbembed.viewSettings': { zh: '视图设置', en: 'View settings' },
  'dbembed.new': { zh: '新建', en: 'New' },
  'dbembed.renameFail': { zh: '重命名失败:{msg}', en: 'Rename failed: {msg}' },
  'dbembed.deleteNoteConfirm': { zh: '删除此行会一并删除对应的笔记文件,确定?', en: 'Deleting this row also deletes its note file. Continue?' },
  // 表体
  'dbembed.noColumns': { zh: '没有列。', en: 'No columns yet.' },
  'dbembed.newColName': { zh: '列 {n}', en: 'Column {n}' },
  'dbembed.addColumn': { zh: '＋ 添加列', en: '＋ Add column' },
  'dbembed.addColumnTitle': { zh: '添加列', en: 'Add column' },
  'dbembed.addRow': { zh: '＋ 新行', en: '＋ New row' },
  'dbembed.groupNone': { zh: '未设置', en: 'Not set' },
  'dbembed.laneNone': { zh: '未分组', en: 'No group' },
  'dbembed.treeToggle': { zh: '折叠 / 展开子任务', en: 'Collapse / expand subtasks' },
  'dbembed.deleteRow': { zh: '删除行', en: 'Delete row' },
  'dbembed.dragRow': { zh: '拖拽调整行顺序', en: 'Drag to reorder rows' },
  'dbembed.dragRowBlocked': { zh: '有排序/筛选/搜索/分组/层级时不能手动调顺序 —— 先清掉', en: 'Manual ordering is off while sorting, filtering, search, grouping or hierarchy is on — clear them first' },
  'dbembed.colMenuHint': { zh: '{type} · 点击打开列菜单 · 拖拽调整列顺序', en: '{type} · click to open the column menu · drag to reorder columns' },
  'dbembed.colMenuHintFixed': { zh: '{type} · 点击打开列菜单(首列是标题列,位置固定)', en: '{type} · click to open the column menu (the first column is the title column and stays put)' },
  'dbembed.resizeHint': { zh: '拖拽调整列宽 · 双击恢复弹性', en: 'Drag to resize · double-click for flexible width' },
  'dbembed.statTitle': { zh: '页脚统计(本视图,基于筛选后的行)', en: 'Footer summary (this view, over the filtered rows)' },
  'dbembed.stat': { zh: '统计', en: 'Summary' },
  'dbembed.statSec': { zh: '页脚统计 · {col}', en: 'Footer summary · {col}' },
  'dbembed.statNone': { zh: '无', en: 'None' },
  // 单元格
  'dbembed.edit': { zh: '编辑', en: 'Edit' },
  'dbembed.clickToEdit': { zh: '点击编辑', en: 'Click to edit' },
  'dbembed.blank': { zh: '空', en: 'Empty' },
  'dbembed.editUrl': { zh: '编辑链接', en: 'Edit link' },
  'dbembed.untitled': { zh: '未命名', en: 'Untitled' },
  'dbembed.openNote': { zh: '打开 {name}', en: 'Open {name}' },
  'dbembed.renameNote': { zh: '重命名笔记', en: 'Rename note' },
  // 关联表 / 投影列
  'dbembed.pickTargetDb': { zh: '在列菜单里选择目标表', en: 'Pick a target table in the column menu' },
  'dbembed.noTargetDb': { zh: '未设目标表', en: 'No target table' },
  'dbembed.relateRows': { zh: '关联 {name} 的行', en: 'Link rows from {name}' },
  'dbembed.targetLoading': { zh: '目标表读取中…', en: 'Loading the target table…' },
  'dbembed.lost': { zh: '已失联', en: 'Missing' },
  'dbembed.openTargetDb': { zh: '打开目标表', en: 'Open target table' },
  'dbembed.projectionPending': { zh: '待配置', en: 'Needs setup' },
  'dbembed.backRows': { zh: '{name} 里指回本行的行(点开增删)', en: 'Rows in {name} that point back here (click to add or remove)' },
  // 目标行选择器
  'dbembed.searchRowsPlaceholder': { zh: '搜索行…', en: 'Search rows…' },
  'dbembed.noMatchingRows': { zh: '无匹配行', en: 'No matching rows' },
  'dbembed.clearRelation': { zh: '清空关联', en: 'Clear links' },
  // 附件
  'dbembed.uploadFail': { zh: '上传失败:{msg}', en: 'Upload failed: {msg}' },
  'dbembed.uploadAttachment': { zh: '上传附件(可多选)', en: 'Upload attachments (multiple allowed)' },
  'dbembed.appendAttachment': { zh: '追加附件', en: 'Add another attachment' },
  'dbembed.removeAttachment': { zh: '移除该附件(不删文件)', en: 'Remove this attachment (the file stays)' },
  // 选项弹层
  'dbembed.optMulti': { zh: '多选(点击切换)', en: 'Multi-select (click to toggle)' },
  'dbembed.optSingle': { zh: '选择一项', en: 'Pick one' },
  'dbembed.optEmpty': { zh: '还没有选项,在下面输入并回车创建。', en: 'No options yet — type below and press Enter to create one.' },
  'dbembed.clear': { zh: '清空', en: 'Clear' },
  'dbembed.optNewPlaceholder': { zh: '回车新增选项…', en: 'Press Enter to add an option…' },
  // 列菜单
  'dbembed.sortSec': { zh: '排序(仅视图,不改文件顺序;多列排序在视图设置里)', en: 'Sorting (view only, the file order stays; multi-column sorting lives in view settings)' },
  'dbembed.sortAsc': { zh: '↑ 升序', en: '↑ Ascending' },
  'dbembed.sortDesc': { zh: '↓ 降序', en: '↓ Descending' },
  'dbembed.clearSort': { zh: '清除排序', en: 'Clear sorting' },
  'dbembed.colOrderFixed': { zh: '列顺序(首列是标题列,位置固定)', en: 'Column order (the first column is the title column and stays put)' },
  'dbembed.colOrder': { zh: '列顺序(也可直接拖表头)', en: 'Column order (you can also drag the header)' },
  'dbembed.moveLeft': { zh: '← 左移', en: '← Move left' },
  'dbembed.moveRight': { zh: '右移 →', en: 'Move right →' },
  'dbembed.formulaSec': { zh: '公式(列引用写 {列名})', en: 'Formula (reference a column as {column name})' },
  'dbembed.formulaPlaceholder': { zh: '如 {单价}*{数量} 或 if({完成},"✓","…")', en: 'e.g. {unit price}*{item count} or if({is done},"✓","…")' },
  'dbembed.formulaHelp': { zh: '支持 + - * / % 比较逻辑与 if / round / len / concat / contains / days / today 等', en: 'Supports + - * / %, comparisons and logic, plus if / round / len / concat / contains / days / today and more' },
  'dbembed.numFmtSec': { zh: '数字显示(只改显示,不动数据)', en: 'Number display (formatting only — the stored value never changes)' },
  'dbembed.precision': { zh: '小数位', en: 'Decimals' },
  'dbembed.precisionPlaceholder': { zh: '跟随原值', en: 'Match the value' },
  'dbembed.prefix': { zh: '前缀', en: 'Prefix' },
  'dbembed.prefixPlaceholder': { zh: '如 ¥', en: 'e.g. $' },
  'dbembed.suffix': { zh: '后缀', en: 'Suffix' },
  'dbembed.suffixPlaceholder': { zh: '如 元 / % / 台', en: 'e.g. kg / % / pcs' },
  'dbembed.numFmtSample': { zh: '示例:{sample}', en: 'Example: {sample}' },
  'dbembed.numFmtNone': { zh: '未设置 = 原样显示(点进单元格编辑的永远是原始值)', en: 'Unset = shown as stored (editing a cell always shows the raw value)' },
  'dbembed.relTargetSec': { zh: '目标表(单元格关联它的行)', en: 'Target table (cells link to its rows)' },
  'dbembed.relSelf': { zh: '本表(自指 · 可做层级树的父列)', en: 'This table (self-reference · can be the parent column of a hierarchy)' },
  'dbembed.noOtherDb': { zh: '库里没有其他多维表', en: 'No other databases in this vault' },
  'dbembed.multiSec': { zh: '多选', en: 'Multiple' },
  'dbembed.allowMulti': { zh: '允许多选(一格关联多行)', en: 'Allow multiple (link several rows in one cell)' },
  'dbembed.chipColSec': { zh: '芯片显示列(目标表的哪一列当文案;缺省首列)', en: 'Chip label column (which target column to show; the first column by default)' },
  'dbembed.refFilterSec': { zh: '限定候选(选择器只列满足条件的目标行)', en: 'Limit candidates (the picker only lists target rows that match)' },
  'dbembed.lookupDirSec': { zh: '方向(正向 = 沿本表关联列取值;反向 = 汇总目标表里指回本表的行)', en: 'Direction (forward = pull values along a relation on this table; reverse = roll up rows in the target table that point back here)' },
  'dbembed.forward': { zh: '正向', en: 'Forward' },
  'dbembed.backward': { zh: '反向', en: 'Reverse' },
  'dbembed.lookupRelSec': { zh: '沿哪个关联列(本表的关联表列)', en: 'Along which relation (a relation column on this table)' },
  'dbembed.lookupPending': { zh: '待重新配置:请选一个关联列', en: 'Needs reconfiguring: pick a relation column' },
  'dbembed.lookupPendingStale': { zh: '待重新配置:原关联列已失效(改回关联表类型即恢复),请选一个关联列', en: 'Needs reconfiguring: the original relation column is no longer valid (switch it back to the relation type to restore it) — pick a relation column' },
  'dbembed.needRelCol': { zh: '先建一个「关联表」列', en: 'Create a Relation column first' },
  'dbembed.backTargetSec': { zh: '目标表(扫它的行)', en: 'Target table (its rows get scanned)' },
  'dbembed.backColSec': { zh: '目标表的哪一列指回本表(它的关联表列)', en: 'Which target column points back here (a relation column on it)' },
  'dbembed.backColBad': { zh: '这一列不指回本表,不能作反向引用', en: 'This column does not point back here, so it cannot drive a reverse lookup' },
  'dbembed.backHere': { zh: '→ 本表', en: '→ this table' },
  'dbembed.noBackCols': { zh: '目标表里还没有「关联表」列(或还没读取完)', en: 'The target table has no Relation column yet (or it is still loading)' },
  'dbembed.projSec': { zh: '用途(投影 = 关联本身,可点开增删;普通引用 = 沿关联取值 / 聚合)', en: 'Purpose (projection = the link itself, editable in place; plain lookup = pull values or aggregate along the link)' },
  'dbembed.projToggle': { zh: '作为可编辑关联(投影):显示指回本行的目标行,真值只存目标表', en: 'Use as an editable link (projection): shows target rows pointing back here; the real value lives only in the target table' },
  'dbembed.lookupColSec': { zh: '引用目标表的哪一列', en: 'Which target column to pull' },
  'dbembed.targetNotReady': { zh: '目标表还没就绪(先给关联列选目标表)', en: 'The target table is not ready yet (give the relation column a target table first)' },
  'dbembed.aggSec': { zh: '聚合', en: 'Aggregate' },
  'dbembed.identityLocked': { zh: '首列(Name)不可删除 · 不可改类型', en: 'The first column (Name) cannot be deleted or retyped' },
  'dbembed.typeSec': { zh: '类型', en: 'Type' },
  'dbembed.deleteCol': { zh: '删除列', en: 'Delete column' },
  // 数据来源文件夹
  'dbembed.folderSec': { zh: '数据来源文件夹(行 = 其中的笔记)', en: 'Source folder (rows are the notes inside it)' },
  'dbembed.loadingShort': { zh: '读取中…', en: 'Loading…' },
  'dbembed.vaultRoot': { zh: '整库(顶层笔记)', en: 'Whole vault (top-level notes)' },
  // 视图菜单
  'dbembed.kanbanGroupSec': { zh: '分组列(单选)', en: 'Group by (a select column)' },
  'dbembed.noSelectCol': { zh: '还没有单选列', en: 'No select column yet' },
  'dbembed.treeSec': { zh: '层级(表格,按指向本表的关联列)', en: 'Hierarchy (table view, by a relation column pointing at this table)' },
  'dbembed.noTreeCol': { zh: '还没有指向本表的关联列(先加一个「关联表」列并把目标表选成本表)', en: 'No relation column points at this table yet (add a Relation column and set its target to this table)' },
  'dbembed.treeOff': { zh: '关闭层级', en: 'Turn off hierarchy' },
  'dbembed.groupSecBlocked': { zh: '分组(层级开启时不生效 —— 先关掉层级)', en: 'Grouping (inactive while hierarchy is on — turn hierarchy off first)' },
  'dbembed.groupSec': { zh: '分组(表格,按单选列 / 日期列)', en: 'Grouping (table view, by a select or date column)' },
  'dbembed.noGroupCol': { zh: '还没有单选列或日期列', en: 'No select or date column yet' },
  'dbembed.groupOff': { zh: '关闭分组', en: 'Turn off grouping' },
  'dbembed.groupUnitSec': { zh: '日期分组档位', en: 'Date grouping unit' },
  'dbembed.byDay': { zh: '按日', en: 'By day' },
  'dbembed.byMonth': { zh: '按月', en: 'By month' },
  'dbembed.dateColSec': { zh: '日期列', en: 'Date column' },
  'dbembed.noDateCol': { zh: '还没有日期列', en: 'No date column yet' },
  'dbembed.ganttStartSec': { zh: '开始列(日历日期)', en: 'Start column (calendar date)' },
  'dbembed.noCalDateCol': { zh: '还没有日历日期列', en: 'No calendar-date column yet' },
  'dbembed.ganttEndSec': { zh: '结束列(缺 = 开始列;单元格是区间时取其末侧)', en: 'End column (unset = the start column; for a range cell the end side wins)' },
  'dbembed.ganttEndSame': { zh: '结束列同开始列', en: 'End column same as start' },
  'dbembed.ganttScaleSec': { zh: '刻度', en: 'Scale' },
  'dbembed.scaleDay': { zh: '日', en: 'Day' },
  'dbembed.scaleWeek': { zh: '周', en: 'Week' },
  'dbembed.chartKindSec': { zh: '图形', en: 'Chart type' },
  'dbembed.chartGroupSec': { zh: '分组列', en: 'Group by' },
  'dbembed.noColumn': { zh: '还没有列', en: 'No columns yet' },
  'dbembed.needNumberCol': { zh: '需要一个数字列', en: 'Needs a number column' },
  'dbembed.chartValueSec': { zh: '数值列({agg})', en: 'Value column ({agg})' },
  'dbembed.noNumberCol': { zh: '还没有数字列', en: 'No number column yet' },
  'dbembed.formTitleSec': { zh: '表单标题 / 提交按钮', en: 'Form title / submit button' },
  'dbembed.formTitlePlaceholder': { zh: '标题(缺省 = {name})', en: 'Title (defaults to {name})' },
  'dbembed.formSubmitPlaceholder': { zh: '提交按钮文案(缺省 = 提交)', en: 'Submit button label (defaults to Submit)' },
  'dbembed.formAfterSec': { zh: '提交后', en: 'After submitting' },
  'dbembed.formStay': { zh: '留在表单', en: 'Stay on the form' },
  'dbembed.formGoTable': { zh: '跳到表格', en: 'Go to the table' },
  'dbembed.formFieldsSec': { zh: '字段(点名字切换必填;默认值 / 说明随填随存;计算列与盖章列不进表单)', en: 'Fields (click a name to toggle required; defaults and hints save as you type; computed and stamped columns stay out of the form)' },
  'dbembed.required': { zh: '必填', en: 'Required' },
  'dbembed.descPlaceholder': { zh: '说明', en: 'Hint' },
  'dbembed.noFormFields': { zh: '没有可填写的字段', en: 'No fillable fields' },
  'dbembed.ownColsSec': { zh: '列序 / 列宽', en: 'Column order / width' },
  'dbembed.ownColsOn': { zh: '关:本视图回到跟全局列序/列宽', en: 'Turn off: this view goes back to the global column order and widths' },
  'dbembed.ownColsOff': { zh: '开:把当前列序/列宽拷成本视图专属,之后拖列拖宽只改本视图', en: 'Turn on: copy the current order and widths into this view; dragging then changes this view only' },
  'dbembed.ownCols': { zh: '本视图独立列序/列宽', en: 'Per-view column order and width' },
  'dbembed.colVisSec': { zh: '列显示(本视图)', en: 'Column visibility (this view)' },
  'dbembed.sortViewSec': { zh: '排序(本视图;点击循环 升→降→移除,可多列)', en: 'Sorting (this view; click to cycle ascending → descending → off, several columns allowed)' },
  'dbembed.filterMore': { zh: '筛选…', en: 'Filter…' },
  'dbembed.calendarSettings': { zh: 'Calendar 设置', en: 'Calendar settings' },
  'dbembed.addToCalendar': { zh: '＋ 添加到 Calendar Space', en: '＋ Add to Calendar Space' },
  'dbembed.deleteView': { zh: '删除视图', en: 'Delete view' },
  'dbembed.lastViewLocked': { zh: '最后一个视图不可删除', en: 'The last view cannot be deleted' },
  // 条件行编辑器
  'dbembed.filterAll': { zh: '全部满足', en: 'Match all' },
  'dbembed.filterAny': { zh: '任一满足', en: 'Match any' },
  'dbembed.valuePlaceholder': { zh: '值…', en: 'Value…' },
  'dbembed.removeCondition': { zh: '移除条件', en: 'Remove condition' },
  'dbembed.noConditions': { zh: '还没有条件。', en: 'No conditions yet.' },
  'dbembed.addCondition': { zh: '＋ 添加条件', en: '＋ Add condition' },
  'dbembed.clearAll': { zh: '清除全部', en: 'Clear all' },
  // 看板 / 日历 / 画廊
  'dbembed.kanbanNeedSelect': { zh: '看板按单选列分组,这张表还没有单选列。', en: 'Board view groups by a select column, and this table has none yet.' },
  'dbembed.addStatusCol': { zh: '＋ 添加「状态」单选列', en: '＋ Add a Status select column' },
  'dbembed.newCard': { zh: '新卡片', en: 'New card' },
  'dbembed.calendarNeedDate': { zh: '日历需要一个日期列(日期 / 日历日期)。', en: 'Calendar view needs a date column (date or calendar date).' },
  'dbembed.addDateCol': { zh: '＋ 添加「日期」列', en: '＋ Add a Date column' },
  'dbembed.calMonth': { zh: '{y} 年 {m} 月', en: '{m} / {y}' },
  'dbembed.today': { zh: '今天', en: 'Today' },
  'dbembed.calDateColHint': { zh: '日历所用的日期列(在视图 tab 菜单里换)', en: 'The date column this calendar uses (switch it in the view tab menu)' },
  'dbembed.addOnDay': { zh: '在这天新建', en: 'New row on this day' },
  'dbembed.dow0': { zh: '日', en: 'Sun' },
  'dbembed.dow1': { zh: '一', en: 'Mon' },
  'dbembed.dow2': { zh: '二', en: 'Tue' },
  'dbembed.dow3': { zh: '三', en: 'Wed' },
  'dbembed.dow4': { zh: '四', en: 'Thu' },
  'dbembed.dow5': { zh: '五', en: 'Fri' },
  'dbembed.dow6': { zh: '六', en: 'Sat' },
})

/** ⚠️ 模块级表只存**键**:文案在渲染时 t(labelKey) 求值。写字面量会冻在模块加载那一刻,切语言不跟。 */
const TYPE_META: Record<ColumnType, { icon: ReactNode; labelKey: string }> = {
  text: { icon: <TextIcon />, labelKey: 'dbembed.type.text' },
  number: { icon: <NumberIcon />, labelKey: 'dbembed.type.number' },
  checkbox: { icon: <CheckBoxCheckLinearIcon />, labelKey: 'dbembed.type.checkbox' },
  date: { icon: <DateTimeIcon />, labelKey: 'dbembed.type.date' },
  select: { icon: <SingleSelectIcon />, labelKey: 'dbembed.type.select' },
  multiselect: { icon: <MultiSelectIcon />, labelKey: 'dbembed.type.multiselect' },
  url: { icon: <LinkIcon />, labelKey: 'dbembed.type.url' },
  page: { icon: <PageIcon />, labelKey: 'dbembed.type.page' },
}

/** 内置扩展类型(住嵌入层不进插件注册表:公式/关联/引用需要整表与跨表上下文,PropCellProps 给不了)。
 *  file=附件(cell 存相对 .db 的路径或 URL);formula/lookup=计算列只读;rowlink=关联另一张 .db 的行。 */
const EXTRA_TYPES = ['file', 'formula', 'rowlink', 'lookup'] as const
const EXTRA_META: Record<string, { icon: ReactNode; labelKey: string }> = {
  file: { icon: <Paperclip size={14} />, labelKey: 'dbembed.type.file' },
  formula: { icon: <Sigma size={14} />, labelKey: 'dbembed.type.formula' },
  rowlink: { icon: <Link2 size={14} />, labelKey: 'dbembed.type.rowlink' },
  lookup: { icon: <ArrowRightLeft size={14} />, labelKey: 'dbembed.type.lookup' },
}
/** 计算列(公式/引用):单元格只读,值由渲染管道物化,不落盘(判据单源在 rowLink.ts,芯片显示列禁选也用它)。 */
const isComputed = isComputedCol
const LOOKUP_AGGS = ['first', 'count', 'sum', 'avg', 'join'] as const
const LOOKUP_AGG_KEY: Record<string, string> = { first: 'dbembed.agg.first', count: 'dbembed.agg.count', sum: 'dbembed.agg.sum', avg: 'dbembed.agg.avg', join: 'dbembed.agg.join' }
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

/** 列元数据(图标/名):自定义注册类型优先,否则内置扩展/primitive,再否则回退显示 type 字符串。 */
const colMeta = (type: string): { icon: ReactNode; labelKey: string } => {
  const custom = getPropertyType(type)
  // 插件注册类型 / 未知类型:labelKey 位置直接放成品文案 —— t() 查不到的键原样返回,正好当兜底。
  if (custom) return { icon: custom.icon, labelKey: custom.label }
  return EXTRA_META[type] ?? TYPE_META[type as ColumnType] ?? { icon: '·', labelKey: type }
}

// ── 多视图(AFFiNE/Notion 式):views 存 .db;缺 = 单「表格」默认视图(旧文件零迁移;
//    viewsOf/DEFAULT_DB_VIEW 单源在 shared/db/schema —— 仪表盘快捷加卡也要物化默认视图) ──
const VIEW_META: Record<DbViewType, { icon: ReactNode; labelKey: string }> = {
  table: { icon: <DatabaseTableViewIcon />, labelKey: 'dbembed.view.table' },
  kanban: { icon: <DatabaseKanbanViewIcon />, labelKey: 'dbembed.view.kanban' },
  calendar: { icon: <TodayIcon />, labelKey: 'dbembed.view.calendar' },
  gallery: { icon: <ImageIcon />, labelKey: 'dbembed.view.gallery' },
  chart: { icon: <ChartPanelIcon />, labelKey: 'dbembed.view.chart' },
  form: { icon: <ClipboardList size={14} />, labelKey: 'dbembed.view.form' },
  gantt: { icon: <ChartGantt size={14} />, labelKey: 'dbembed.view.gantt' },
}
/** 未知视图类型(前向兼容)回退表格观感的元数据。 */
const viewMeta = (type: string): { icon: ReactNode; labelKey: string } => VIEW_META[type as DbViewType] ?? VIEW_META.table
const CHART_KIND_KEY: Record<string, string> = { bar: 'dbembed.chartKind.bar', line: 'dbembed.chartKind.line', donut: 'dbembed.chartKind.donut' }
const CHART_AGG_KEY: Record<string, string> = { count: 'dbembed.chartAgg.count', sum: 'dbembed.chartAgg.sum', avg: 'dbembed.chartAgg.avg' }
/** 日历可用的日期列:primitive/自定义 baseType=date,或内置 calendarDate / created(baseType=text 需点名;
 *  created 存 `YYYY-MM-DDTHH:mm` 与 calendarDate 单侧串同款,parseCalDate 直接认)。
 *  ⚠️ 「缺省挑第一个日期列」的地方用 firstDateish:created 只当兜底,别抢在真日期列前面。 */
const isDateish = (c: DbColumn): boolean => resolveBaseType(c.type) === 'date' || c.type === 'calendarDate' || c.type === 'created'
const firstDateish = (cols: DbColumn[]): DbColumn | undefined =>
  cols.find((c) => isDateish(c) && c.type !== 'created') ?? cols.find(isDateish)

/** 列的筛选/统计求值语义(按给定列集解析,本表与关联目标表都用它):日历日期列(基类 text)按 date 求值;
 *  关联表列按 select(单值)/ multiselect(多选)求值(值 = 目标行 id,FiltersPop 给标题 picker);其余走 baseType。 */
const kindOfIn = (cols: DbColumn[]) => (colId: string): ColumnType | null => {
  const c = cols.find((x) => x.id === colId)
  if (!c) return null
  if (c.type === 'rowlink') return c.multiple ? 'multiselect' : 'select'
  if (isLinksProjection(c)) return 'multiselect' // 投影列(可编辑反向关联):值 = 指回本行的目标行 id 数组
  return isDateish(c) ? 'date' : resolveBaseType(c.type)
}

/** chip 色板类:label 简单字符串哈希 → 'amx-chip-c0'..'amx-chip-c9',同名恒同色。
 *  色板是内容色(区分选项)而非主题色,10 色定义在 amadeus-host.css 的 .amx-db 段。 */
const chipClass = (label: string): string => {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return `amx-chip-c${Math.abs(h) % 10}`
}

/** 列宽夹取:太窄列头没法点,太宽失控;与 CSS 弹性列 minmax(140px,1fr) 并存。 */
const clampW = (w: number): number => Math.min(800, Math.max(100, w))

/** 行标题 = 首列(身份列)显示值:看板/日历/画廊的卡片标题、工具栏搜索。
 *  ⚠️ 关联侧(别的表的 rowlink 芯片 / 选择器 / 排序键)**不走这里**,走 rowLink.linkLabel(按列的 titleCol,缺省才是首列)。 */
const dbRowTitle = (d: DbFile, r: DbRow): string => {
  const c0 = d.columns[0]
  if (!c0) return ''
  const v = coerceForDisplay(r.cells[c0.id], resolveBaseType(c0.type))
  const s = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)
  return s.trim() // 空 = 由调用方按当前语言补「未命名」(模块级不能调 hook)
}
const dirOf = (p: string): string => p.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
/** 附件 cell 值 → 可显示 src(URL 直用;相对路径按 .db 所在目录解析成 asset URL)。 */
const fileSrc = (dbPath: string, raw: string): string =>
  /^https?:\/\//i.test(raw) ? raw : toAssetUrl(joinRel(dirOf(dbPath), raw))

/** 单元格环境:附件列要 .db 路径定位资源,关联表列要目标库数据(注册表 PropCellProps 给不了这些)。 */
interface CellEnv {
  dbPath: string
  /** 关联表列 / 投影列(反向 lookup)的目标库(未加载给 null)。 */
  targetOf(col: DbColumn): { path: string; db: DbFile } | null
  /** 投影列(可编辑反向关联)专用写口:让**目标表** targetRowId 那行的 backCol 含 / 不含本行 —— 对侧表一次 mutate(见 db/backlink.ts)。 */
  backLinkEdit(col: DbColumn, rowId: string, targetRowId: string, add: boolean): void
  /** 投影列配置体检文案(null = 配好了,渲 chip;否则渲提示)。 */
  projectionIssue(col: DbColumn): string | null
}

interface Pop {
  kind: 'options' | 'colmenu' | 'folder' | 'viewmenu' | 'addview' | 'row' | 'filters' | 'stat' | 'calendar'
  colId?: string
  rowId?: string
  viewId?: string
  x: number
  y: number
  /** 触发按钮的上沿:弹层在下方放不下时翻到它之上(见 engine/menuAnchor)。 */
  anchorTop?: number
}

export function DatabaseEmbed({ target, pagePath, initialView, onViewChange }: {
  target: string
  pagePath: string
  /** 嵌入语法 `![[db|视图名]]` 里的激活视图名(存笔记 md,每处嵌入各记各的;不落 .db、不参与云同步)。 */
  initialView?: string | null
  /** 用户切视图时回写笔记的嵌入块 md(改成 `![[db|新视图名]]`);null = 回到默认(去掉管道段)。 */
  onViewChange?: (viewName: string | null) => void
}) {
  const { t } = useI18n()
  const entry = useDbStore((s) => s.entries[target])
  // gen:缓存被整片作废(切库 / 启动时 vault 落地)后重读 —— 见 dbStore 的 gen 注释。
  const gen = useDbStore((s) => s.gen)
  useEffect(() => {
    void useDbStore.getState().load(pagePath, target)
  }, [pagePath, target, gen])

  if (!entry || entry.status === 'loading') {
    return <div className="amx-db amx-db-state">{t('dbembed.loading')}</div>
  }
  if (entry.status === 'missing') {
    return (
      <div className="amx-db amx-db-state">
        {t('dbembed.missing')}<code>{target}</code>
        <button className="amx-db-linkbtn" onClick={() => void useDbStore.getState().reload(pagePath, target)}>{t('dbembed.retry')}</button>
      </div>
    )
  }
  if (entry.status === 'corrupt' || !entry.data) {
    return (
      <div className="amx-db amx-db-state">
        {entry.message ? t('dbembed.corruptDetail', { detail: entry.message }) : t('dbembed.corrupt')}
        {entry.path && (
          <button className="amx-db-linkbtn" onClick={() => void amadeus.revealInFileManager(entry.path!)}>
            {t('dbembed.reveal')}
          </button>
        )}
        <button className="amx-db-linkbtn" onClick={() => void useDbStore.getState().reload(pagePath, target)}>{t('dbembed.retry')}</button>
      </div>
    )
  }
  return <DbTable dbRef={target} db={entry.data} pagePath={pagePath} initialView={initialView} onViewChange={onViewChange} />
}

function DbTable({ dbRef, db, pagePath, initialView, onViewChange }: {
  dbRef: string
  db: DbFile
  pagePath: string
  initialView?: string | null
  onViewChange?: (viewName: string | null) => void
}) {
  const { t } = useI18n()
  const [pop, setPop] = useState<Pop | null>(null)
  const [q, setQ] = useState('') // 工具栏搜索:按行标题过滤
  // 拖拽改宽的过程态:pointermove 只写这里驱动 gridTemplateColumns 即时反馈,pointerup 才落进 column。
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})
  usePropertyTypesVersion() // 三方插件注册/卸载属性类型 → 列菜单与单元格分发即时刷新

  // 笔记视图(Bases):db.source.folder 存在 → 行 = 该文件夹里的笔记(实时,来自 noteViewStore),
  // 不走 .db rows;列(视图定义)仍存 .db。首列恒为不可删的 Name 身份列(普通表=text,笔记视图=page)。
  const noteFolder = db.source?.folder
  const isNoteView = noteFolder !== undefined
  const nv = (): ReturnType<typeof useNoteViewStore.getState> => useNoteViewStore.getState()
  const nvProps = useNoteViewStore((s) => (isNoteView ? s.folders[noteFolder as string]?.props : undefined))
  useEffect(() => {
    if (isNoteView) void useNoteViewStore.getState().load(noteFolder as string)
  }, [isNoteView, noteFolder])

  const m = (fn: (d: DbFile) => DbFile): void => useDbStore.getState().mutate(dbRef, fn)
  const dbPath = useDbStore((s) => s.entries[dbRef]?.path) ?? dbRef // 规范文件路径(= 日历成员键 / openDb 用)
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const calByVault = useCalendarConfig((s) => s.byVault)
  const addMember = useCalendarConfig((s) => s.addMember)

  const identityId = db.columns[0]?.id
  const isIdentity = (colId: string): boolean => colId === identityId

  // 视图:激活项是本嵌入的局部态(同 db 多处嵌入各看各的,切 tab 不写盘);视图定义存 .db。
  // 激活视图初值:从嵌入语法的视图名(initialView)按名字解析;找不到=null(回退首个视图)。
  const [viewId, setViewId] = useState<string | null>(() => viewsOf(db).find((v) => v.name === initialView)?.id ?? null)
  const views = viewsOf(db)
  const view = views.find((v) => v.id === viewId) ?? views[0]
  // 用户显式切/建视图:置激活 + 把视图名回写进笔记的嵌入块 md(持久化,每处嵌入各记各的)。
  const pickView = (v: DbView): void => { setViewId(v.id); onViewChange?.(v.name) }
  const addView = (type: DbViewType): void => {
    const v: DbView = { id: dbId(), name: t(VIEW_META[type].labelKey), type }
    m((d) => ({ ...d, views: [...viewsOf(d), v] }))
    pickView(v)
    setPop(null)
  }
  const patchView = (id: string, patch: Partial<DbView>): void => {
    m((d) => ({ ...d, views: viewsOf(d).map((v) => (v.id === id ? { ...v, ...patch } : v)) }))
    if (id === viewId && patch.name) onViewChange?.(patch.name) // 改名活动视图 → 同步嵌入引用,免下次重挂失配
  }
  const delView = (id: string): void => {
    m((d) => {
      const rest = viewsOf(d).filter((v) => v.id !== id)
      return { ...d, views: rest.length ? rest : [DEFAULT_DB_VIEW] }
    })
    if (viewId === id) { setViewId(null); onViewChange?.(null) } // 删的是活动视图 → 嵌入回到默认(去管道段)
    setPop(null)
  }
  // 排序自 2.7 起落盘在视图上;2.8 起支持多列(sorts),写端保持 sort = sorts[0] 镜像供旧应用读。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sortsOf 只读这两个字段
  const sorts = useMemo(() => sortsOf(view), [view.sorts, view.sort])
  const sortOf = (colId: string): { dir: 'asc' | 'desc'; idx: number } | null => {
    const i = sorts.findIndex((s) => s.colId === colId)
    return i < 0 ? null : { dir: sorts[i].dir, idx: i }
  }
  const kindOf = kindOfIn(db.columns)
  /** 本视图可见列:先按视图独立列序(view.order,缺 = 全局序;首列恒 0 位)排,再滤隐藏列;首列(身份列)恒可见。
   *  投影列(lookupKind='links')与普通列一样参与排序,不特殊对待。 */
  const visCols = orderColumns(db.columns, view.order).filter((c, i) => i === 0 || !(view.hidden ?? []).includes(c.id))

  // 关联表(rowlink)目标库 + 反向引用(lookup 带 refDb+lookupBackCol)要扫的目标库:按需加载 + 窄订阅
  // (只跟这些路径的 entry.data 引用变化,别的库编辑不扰动本嵌入)。
  // ⚠️ 反向 lookup 列自己带 refDb 却不是 rowlink —— 漏收它 = 目标库永不加载、rollup 恒空且不刷新。
  const refPaths = useMemo(
    () => [...new Set(db.columns.filter((c) => (c.type === 'rowlink' || isBackLookup(c)) && c.refDb).map((c) => c.refDb as string))],
    [db.columns],
  )
  useEffect(() => {
    for (const p of refPaths) void useDbStore.getState().load(p, p)
  }, [refPaths])
  const refDbs = useDbStore(useShallow((s) => refPaths.map((p) => s.entries[p]?.data ?? null)))
  const targetOf = (col: DbColumn): { path: string; db: DbFile } | null => {
    // 反向 lookup(含投影列)的 refDb 也在 refPaths 里:投影 cell 渲 chip / 开 picker 要目标库整份
    if (!(col.type === 'rowlink' || isBackLookup(col)) || !col.refDb) return null
    const d = refDbs[refPaths.indexOf(col.refDb)]
    return d ? { path: col.refDb, db: d } : null
  }
  /** 按路径取目标库(computeRowLookups 的 getDb 契约;未收进 refPaths / 未加载 → null)。 */
  const refDbByPath = (p: string): DbFile | null => {
    const i = refPaths.indexOf(p)
    return i < 0 ? null : (refDbs[i] ?? null)
  }

  const isTableLike = !['kanban', 'calendar', 'gallery', 'chart', 'form', 'gantt'].includes(view.type)
  // 层级树(2.9):view.treeCol 指本表的自指关联列时,表格体按父子缩进渲染。判据单源在 rowLink.resolveTreeCol
  // (列还在且仍是 rowlink+refDb 指回本表);按 db.columns 解析而不是 visCols —— 把父列隐藏只看缩进是常见用法。
  const treeCol = isTableLike ? resolveTreeCol(db.columns, view.treeCol, [dbPath, dbRef]) : null
  // 表格分组(2.8):view.groupBy 在表格视图也生效(单选列;2.9 起放开到日期列,档位见 view.groupUnit)。
  // ⚠️ 与层级树**互斥,树优先**:树序是全表一条链,再切成组只会让父子跨组分离(父在别组 = 孤儿 = 整表退平铺,
  //    白开一场)。菜单里分组区在开了树时灰掉并写明理由。
  const tableGroupCol = isTableLike && view.groupBy && !treeCol
    ? (db.columns.find((c) => c.id === view.groupBy && (resolveBaseType(c.type) === 'select' || isDateish(c))) ?? null)
    : null
  const groupUnit: DateGroupUnit = dateGroupUnitOf(view.groupUnit)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // ponytail: 树节点折叠态只存内存(与分组折叠同款),**不落盘** —— 它是「我现在想看哪块」的临时视线,
  // 不是视图配置;落盘会让同一视图的多处嵌入/多标签互相抢折叠状态。键带 view.id:切视图自动复位。
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())

  // 行数据源:笔记视图从 store 合成(cell key = 列 id = frontmatter 键;page 列 = 笔记标题)。
  const baseRows: DbRow[] = useMemo(() => {
    if (!isNoteView) return db.rows
    return (nvProps ?? []).map((p) => ({
      id: p.path,
      cells: Object.fromEntries(db.columns.map((c) => [c.id, c.type === 'page' ? p.title : fmValueToCell(p.fm[c.id], resolveBaseType(c.type))])),
    }))
  }, [isNoteView, db.rows, db.columns, nvProps])

  /** 投影列(可编辑反向关联)的唯一写口:真值在目标表(refDb)的 backCol rowlink cell,所以对**目标表**做一次 mutate
   *  (单文件、原子、无跨文件事务);先 load 确认目标库在 store 里。fn 在回调内按最新目标表算(CAS 冲突重放语义),
   *  不用渲染期闭包里的 ids;没变化返 null → 不产生保存/撤销点。本表磁盘永不落投影 cell。 */
  const mutateBackLinks = (col: DbColumn, fn: (target: DbFile) => DbRow[] | null): void => {
    const ref = col.refDb as string
    void useDbStore.getState().load(ref, ref).then(() => {
      useDbStore.getState().mutate(ref, (t) => { const rows = fn(t); return rows ? { ...t, rows } : t })
    })
  }
  const editBackLink = (col: DbColumn, rowId: string, targetRowId: string, add: boolean): void =>
    mutateBackLinks(col, (t) => backLinkEdit(t, col.lookupBackCol as string, rowId, targetRowId, add))

  const setCell = (rowId: string, colId: string, v: CellValue | undefined): void => {
    const col0 = db.columns.find((c) => c.id === colId)
    const colType = col0?.type ?? ''
    // 投影列:isComputed 闸对它放行到专用写口(整格赋值 = 指回本行的目标行集合恰好 = v 里的 id;undefined/[] = 全摘);其余计算列照旧拒
    if (col0 && isLinksProjection(col0)) { mutateBackLinks(col0, (t) => backLinkSet(t, col0.lookupBackCol as string, rowId, rowLinkIds(v))); return }
    if (isComputed(colType)) return // 计算列只读,物化值绝不落盘
    if (isStamped(colType)) return // 盖章列(自动编号/创建时间)建行即定,之后只读(Cell 不给入口只是纪律,这里才是护栏)
    // 活动日志:行属性变更(通用,任何列类型)——row.edit db+p=列名+v=新值+行标题,同格 10s 防抖取末态。
    // 身份列变更 text=新标题;其余列行名从合成 baseRows 取(笔记视图 db.rows 不是显示行)。
    const actCol = db.columns.find((c) => c.id === colId)
    if (actCol) {
      const idColId = db.columns[0]?.id ?? ''
      const name = colId === idColId ? shortVal(v) : shortVal(baseRows.find((r) => r.id === rowId)?.cells[idColId])
      actDebounced('row.edit', { db: dbRef, p: actCol.name, v: shortVal(v), text: name }, `${dbRef}|${rowId}|${colId}`)
    }
    if (isNoteView) {
      const col = db.columns.find((c) => c.id === colId)
      if (col?.type === 'page') {
        // Page Name = 文件名:提交即重命名笔记(不落 frontmatter)。
        if (v != null && String(v).trim()) void nv().renameNote(noteFolder as string, rowId, String(v))
        return
      }
      nv().setProp(noteFolder as string, rowId, colId, v, resolveBaseType(col?.type ?? 'text'))
      return
    }
    m((d) => ({
      ...d,
      rows: d.rows.map((r) => {
        if (r.id !== rowId) return r
        const cells = { ...r.cells }
        if (v === undefined) delete cells[colId]
        else cells[colId] = v
        return { ...r, cells }
      }),
    }))
  }
  /** 新行,可带初值(看板加卡入组/日历日格加行);笔记视图 = 建笔记后逐键写 frontmatter。 */
  const addRow = (initial?: Record<string, CellValue>): void => {
    // 活动日志:含 todo 列=任务、日期列=日程,其余=普通行(标题此刻必空,由 setCell 的 task.name 补)
    // created(创建时间)虽算日期列,但一张只有它的表不是日程表 → 不算 event.new
    act(db.columns.some((c) => c.type === 'todo') ? 'task.new' : db.columns.some((c) => isDateish(c) && c.type !== 'created') ? 'event.new' : 'row.new', { db: dbRef })
    if (isNoteView) {
      void nv().addNote(noteFolder as string).then((p) => {
        if (!initial) return
        for (const [k, v] of Object.entries(initial)) {
          const col = db.columns.find((c) => c.id === k)
          if (col && col.type !== 'page') nv().setProp(noteFolder as string, p, k, v, resolveBaseType(col.type))
        }
      })
      return
    }
    // ⚠️ id 必须在回调**外**定下:冲突重放会重跑这个回调(见 dbStore 的 pendingOps),
    // 回调内生成 = 每次重放换一个新 id,后续那条「往这行填内容」的 op 就找不到目标了。
    const rowId = dbId()
    // 而盖章(自动编号 max+1 / 创建时间)恰好相反,必须在回调**内**按 d.rows 算:重放时 d 是重读后的最新
    // 磁盘行,引擎刚加进来的那行也在里面 → 编号不撞;initial(看板分组值/日历日期)压在盖章之后。
    // 盖章压在**最后**(与 dbAggregateStore.createAggEvent 同序):看板/日历给的 initial 只会是分组列或日期列,
    // 与盖章键不重叠时照常保留;若用户把日历锚在 created 列上,点击日不得伪造创建时间(codex 抓的)。
    m((d) => ({ ...d, rows: [...d.rows, { id: rowId, cells: { ...(initial ?? {}), ...newRowCells(d) } }] }))
  }
  /** 拖拽重排:把 dragId 挪到 targetId 之前/之后。顺序就是 db.rows 的数组序,直接落盘。 */
  const reorderRow = (dragId: string, targetId: string, after: boolean): void => {
    m((d) => {
      const rows = moveRow(d.rows, dragId, targetId, after)
      return rows === d.rows ? d : { ...d, rows } // 引用没变 = 没动 → 不产生保存/撤销点
    })
  }
  const delRow = (rowId: string): void => {
    if (isNoteView) {
      if (window.confirm(t('dbembed.deleteNoteConfirm'))) void nv().deleteNote(noteFolder as string, rowId)
      return
    }
    // 同文件内的自引用(本表 rowlink 指回本表)顺手摘掉;跨文件悬空刻意不级联(见 rowLink.dropSelfRefs)。
    // 在回调内按 d 算(CAS 重放语义),不用渲染期闭包的 rows。
    m((d) => dropSelfRefs({ ...d, rows: d.rows.filter((r) => r.id !== rowId) }, rowId, [dbPath, dbRef]))
  }
  const addCol = (): void => {
    const newId = dbId() // 同 addRow:回调外定 id,重放才是确定的
    m((d) => {
      // 笔记视图:新列 id = frontmatter 键(取唯一默认键);普通表:随机 id + 显示名。
      // 新列的**缺省显示名**按当前语言给(落盘后就是普通用户数据,之后改语言不动它);笔记视图那支的 id = frontmatter 键,恒中文不可翻。
      if (!isNoteView) return { ...d, columns: [...d.columns, { id: newId, name: t('dbembed.newColName', { n: d.columns.length + 1 }), type: 'text' }] }
      const have = new Set(d.columns.map((c) => c.id))
      let id = '属性'
      let i = 1
      while (have.has(id)) id = `属性${++i}`
      return { ...d, columns: [...d.columns, { id, name: id, type: 'text' }] }
    })
  }
  /** 改列配置的唯一写口(改名/改类型/列菜单各项都经这里)。
   *  关联列**换目标表** → 依赖它的正向 lookup 作废(lookupRel/lookupCol 置空,ColMenu 显示「待重新配置」:lookupCol 是旧目标表的列 id,
   *  留着必悬空),本列的 titleCol/refFilter 同理一并清。
   *  ⚠️ 关联列**改成别的类型不清**:切类型本就是非破坏式的(列自己的 refDb 留着),依赖它的 lookup 只是**休眠**——lookup.ts 只沿
   *  type==='rowlink' 的列取值,期间显示空、ColMenu 提示「原关联列已失效」;改回关联表即原样恢复。之前一改类型就清是不可逆的
   *  (Codex 评审抓的),真正的 detach 只剩换 refDb 与删列(delCol)两处。 */
  const patchCol = (colId: string, patch: Partial<DbColumn>): void =>
    m((d) => {
      const old = d.columns.find((c) => c.id === colId)
      if (!old) return d
      let columns = d.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c))
      const refDbChanged = old.type === 'rowlink' && 'refDb' in patch && patch.refDb !== old.refDb
      if (refDbChanged) columns = detachLookups(columns.map((c) => (c.id === colId ? { ...c, titleCol: undefined, refFilter: undefined, refFilterMode: undefined } : c)), colId)
      return { ...d, columns }
    })
  // 列改名:笔记视图的属性列 → 跨该文件夹所有笔记重写 frontmatter 键(列 id = 键);其余仅改显示名。
  const renameCol = (col: DbColumn, name: string): void => {
    if (isNoteView && col.type !== 'page' && name !== col.id) {
      if (db.columns.some((c) => c.id === name)) return // 目标键已是某列,避免撞键覆盖 + 重复列 id
      void nv().renameProp(noteFolder as string, col.id, name)
      m((d) => ({ ...d, columns: d.columns.map((c) => (c.id === col.id ? { ...c, id: name, name } : c)) }))
    } else {
      patchCol(col.id, { name })
    }
  }
  /**
   * 列重排:列顺序就是 `db.columns` 的数组序(**没有每视图的列序**,visCols 只是在它上面滤掉隐藏列),
   * 所以直接复用行拖拽那份 moveRow。
   *
   * ⚠️ 首列是**标题列**:`dbRowTitle` 恒取 `columns[0]`,看板/日历/画廊的卡片标题、以及**别的表
   * rowlink 芯片上显示的文字**(linkLabel 在没设 titleCol 时的缺省)全从它来。所以它既不能被拖走、别的列也不能
   * 落到它前面 —— 否则拖一下列顺序,全库的关联芯片会集体改名。这道闸在这里(权威),不只在 UI 上灰掉。
   */
  /** 视图带独立列序时的落点:在 orderColumns 的**结果**上跑 moveColumn(这样它看到的 [0] 才是首列,闸才成立;
   *  直接把 order.map(id=>({id})) 喂给它,order 里首列不在 0 位时闸就失效),存回 id 序;没变 → null。 */
  const moveViewOrder = (columns: DbColumn[], order: string[], dragId: string, targetId: string, after: boolean): string[] | null => {
    const cur = orderColumns(columns, order)
    const next = moveColumn(cur, dragId, targetId, after)
    return sameOrder(next, cur) ? null : next.map((c) => c.id)
  }
  const reorderCol = (dragId: string, targetId: string, after: boolean): void => {
    // 先按当前快照挡掉「看着什么也没发生」的手势(拖到自己身上、拖到已相邻的那一侧)。必须挡在 m()
    // **之前**:mutate 是无条件把回调排进 pendingOps 的,而 pendingOps 会在 CAS 冲突后重放到别人
    // 刚写的新数据上 —— 一次视觉空操作到那时就成了真改动,把对方的列序顶回去(Codex 抓的)。
    const noop = view.order
      ? moveViewOrder(db.columns, view.order, dragId, targetId, after) === null
      : sameOrder(moveColumn(db.columns, dragId, targetId, after), db.columns)
    if (noop) return
    // 首列闸在 moveColumn 里、按它拿到的那份 columns 判 —— 本回调会被重放到重读后的新数据上,
    // 判据必须跟着那份数据走,不能用渲染期闭包里的 identityId(见 moveColumn 的注释)。
    // 「写视图还是写全局」同理按 d 里的视图判,不吃渲染期的 view.order。
    m((d) => {
      const v = viewsOf(d).find((x) => x.id === view.id)
      if (v?.order) {
        const order = moveViewOrder(d.columns, v.order, dragId, targetId, after)
        return order ? { ...d, views: viewsOf(d).map((x) => (x.id === v.id ? { ...x, order } : x)) } : d
      }
      const columns = moveColumn(d.columns, dragId, targetId, after)
      return sameOrder(columns, d.columns) ? d : { ...d, columns }
    })
  }
  /** 列菜单的「← 左移 / 右移 →」:按**可见**相邻列算落点,否则相邻列恰好被隐藏时点了看着像没反应。 */
  const moveColBy = (colId: string, dir: -1 | 1): void => {
    const i = visCols.findIndex((c) => c.id === colId)
    const target = visCols[i + dir]
    if (i < 0 || !target) return
    reorderCol(colId, target.id, dir > 0)
  }
  const delCol = (colId: string): void => {
    if (isIdentity(colId)) return // 首列(Name)不可删除
    m((d) => ({
      ...d,
      columns: detachLookups(d.columns.filter((c) => c.id !== colId), colId), // 删的是关联列 → 沿它取值的 lookup 待重新配置
      rows: d.rows.map((r) => {
        if (!(colId in r.cells)) return r
        const cells = { ...r.cells }
        delete cells[colId]
        return { ...r, cells }
      }),
    }))
  }
  const createOption = (colId: string, label: string): void =>
    m((d) => ({
      ...d,
      columns: d.columns.map((c) =>
        c.id === colId && !(c.options ?? []).includes(label) ? { ...c, options: [...(c.options ?? []), label] } : c,
      ),
    }))

  /** 卡片/事件标题 = 首列(身份列)显示值。 */
  const rowTitle = (r: DbRow): string => dbRowTitle(db, r) || t('dbembed.untitled')
  /** 单元格环境(附件/关联表列用);env 身份跟 refDbs 走,目标库更新时 Cell 重渲染。 */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- targetOf 闭包依赖 refPaths/refDbs/db.columns(已在列)
  const cellEnv = useMemo<CellEnv>(() => ({
    dbPath,
    targetOf,
    backLinkEdit: editBackLink,
    projectionIssue: (c) => projectionIssue(c, refDbByPath, [dbPath, dbRef])?.detail ?? null,
  }), [dbPath, refDbs, refPaths, db.columns])
  const allFiles = usePageStore((s) => s.files)
  const dbFiles = useMemo(() => allFiles.filter((f) => /\.db$/i.test(f) && f !== dbPath), [allFiles, dbPath])
  /** 目标表列清单(lookup 配置用;目标库没加载完给空)。 */
  const targetColsOf = (refDb: string): DbColumn[] => useDbStore.getState().entries[refDb]?.data?.columns ?? []
  /** 画廊封面:首个附件列里**第一张图片**(仅图片扩展名;URL 直用)。
   *  ⚠️ 走 fileRefs 而不是 `typeof raw === 'string'`:多附件格是数组,老写法会让这类行的封面整个消失。 */
  const coverOf = (r: DbRow): ReactNode => {
    const fc = visCols.find((c) => c.type === 'file')
    const raw = fc ? fileRefs(r.cells[fc.id]).find((x) => IMG_EXT_RE.test(x.split('?')[0])) : undefined
    if (!raw) return null
    return <img className="amx-db-card-cover" src={fileSrc(dbPath, raw)} alt="" loading="lazy" />
  }
  /** 弹层落点 = 按钮下沿(放不下时 OverlayAt 自会翻到 anchorTop=按钮上沿之上)。
   *  ⚠️别在这里按「估算高度」预夹 y:预夹过的 y 会被当成真锚点再翻一次面(codex#2)。 */
  const openRow = (e: ReactMouseEvent, rowId: string): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPop({ kind: 'row', rowId, x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  /** 看板/日历引导:一键补齐可分组/可上历的列(笔记视图列 id = frontmatter 键,撞键则不动)。 */
  const addStatusCol = (): void => {
    const rid = dbId()
    m((d) => {
      const id = isNoteView ? '状态' : rid
      if (isNoteView && d.columns.some((c) => c.id === id)) return d
      return { ...d, columns: [...d.columns, { id, name: '状态', type: 'select', options: ['待办', '进行中', '完成'] }] }
    })
  }
  const addDateCol = (): void => {
    const rid = dbId()
    m((d) => {
      const id = isNoteView ? '日期' : rid
      if (isNoteView && d.columns.some((c) => c.id === id)) return d
      return { ...d, columns: [...d.columns, { id, name: '日期', type: 'calendarDate' }] }
    })
  }

  // 笔记视图:切换数据来源文件夹 → 并集推导列(导入该文件夹笔记的 frontmatter 键)。
  const setFolder = async (folder: string): Promise<void> => {
    const props = await amadeus.listPageProps(folder)
    m((d) => ({ ...d, source: { folder }, columns: deriveColumns(d.columns, props.map((p) => p.fm)) }))
    void nv().refresh(folder)
    setPop(null)
  }

  /** 单列排序入口(列菜单/表头):设为唯一排序;null = 清空。多列走 cycleSort。 */
  const setColSort = (colId: string, dir: 'asc' | 'desc' | null): void =>
    patchView(view.id, dir === null ? { sorts: undefined, sort: undefined } : { sorts: [{ colId, dir }], sort: { colId, dir } })
  /** 视图菜单多列排序:点击循环 升→降→移除;新列追加末位。sort 恒 = sorts[0] 镜像。 */
  const cycleSort = (colId: string): void => {
    const i = sorts.findIndex((s) => s.colId === colId)
    const next =
      i < 0 ? [...sorts, { colId, dir: 'asc' as const }]
      : sorts[i].dir === 'asc' ? sorts.map((s, j) => (j === i ? { ...s, dir: 'desc' as const } : s))
      : sorts.filter((_, j) => j !== i)
    patchView(view.id, { sorts: next.length ? next : undefined, sort: next[0] })
  }
  const clearSorts = (): void => patchView(view.id, { sorts: undefined, sort: undefined })

  // today() 的换日键:跨午夜后计算列不该继续显示昨天的结果 —— 到点换键,memo 随之重算。
  const [dayKey, setDayKey] = useState(todayStr)
  useEffect(() => {
    const now = new Date()
    const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
    const timer = setTimeout(() => setDayKey(todayStr()), msToMidnight + 1000)
    return () => clearTimeout(timer)
  }, [dayKey])

  // 计算列物化:lookup 先(公式可引用其结果)再整行公式;只进呈现管道,绝不落盘。
  const compRows: DbRow[] = useMemo(() => {
    const lookupCols = db.columns.filter((c) => c.type === 'lookup')
    if (!lookupCols.length && !db.columns.some((c) => c.type === 'formula')) return baseRows
    // 正向/多值/反向三种 lookup 都在 shared/db/lookup.ts(引擎物化同一份);这里只负责喂目标库。
    const opts = { today: dayKey }
    return baseRows.map((r) => {
      const cells = { ...r.cells, ...computeRowLookups(db, r, refDbByPath, opts) }
      return { ...r, cells: { ...cells, ...evalRowFormulas(db.columns, cells, opts) } }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refDbByPath 只依赖 refPaths/refDbs(已在列)
  }, [baseRows, db.columns, refDbs, refPaths, dayKey])

  // 行管道:每视图筛选(AND/OR)→ 每视图排序(多列逐层;都存在视图配置里,不动文件 rows 顺序)。
  // 行拖拽重排。⚠️ 只在「无排序、无筛选/搜索、无分组、无层级」时开放:呈现出来的 rows 是合成结果,
  // 它的相邻关系和 db.rows 的数组序对不上,拿屏幕上的落点去改数组只会把顺序改乱。
  // 树序更是如此(父子交错),把落点当数组下标会把整棵树打散。
  // 笔记视图的行是文件夹里的笔记,没有数组序可言,一并排除。
  const [drag, setDrag] = useState<{ id: string; overId: string; after: boolean } | null>(null)
  const canReorder = !isNoteView && !sorts.length && !q.trim() && !(view.filters ?? []).length && !tableGroupCol && !treeCol
  // 列拖拽:与行不同,**不受排序/筛选/分组影响** —— 列序是 db.columns 的数组序,和呈现出来的行没关系。
  const [colDrag, setColDrag] = useState<{ id: string; overId: string; after: boolean } | null>(null)

  const rows = useMemo(() => {
    const af = applyFilters(compRows, view.filters, kindOf, view.filterMode)
    const needle = q.trim().toLowerCase()
    const filtered = needle ? af.filter((r) => rowTitle(r).toLowerCase().includes(needle)) : af
    if (!sorts.length) return filtered
    const keyOf = (r: DbRow, colId: string): string | number => {
      const col = db.columns.find((c) => c.id === colId)
      if (!col) return ''
      const custom = getPropertyType(col.type)
      if (custom?.sortValue) return custom.sortValue(r.cells[col.id] ?? null)
      // 计算列:物化值直接当键(数字按数值比,其余按文本);投影列与关联表列同款按目标行标题排。
      if (isComputed(col.type) && !isLinksProjection(col)) {
        const raw = r.cells[col.id]
        return typeof raw === 'number' ? raw : Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      }
      // 关联表列:按目标行**标题**排(不是按 id 串);多选拼接。目标库没到 → 退回 id 串。
      if (col.type === 'rowlink' || isLinksProjection(col)) {
        const tgt = targetOf(col)
        return rowLinkIds(r.cells[col.id]).map((id) => { const hit = tgt?.db.rows.find((x) => x.id === id); return hit ? linkLabel(tgt!.db, hit, col.titleCol) : id }).join(', ')
      }
      const base = resolveBaseType(col.type)
      const v = coerceForDisplay(r.cells[col.id], base)
      if (base === 'number') return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY
      if (base === 'checkbox') return v === true ? 1 : 0
      return Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    return applySorts(filtered, sorts, keyOf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kindOf/rowTitle 只依赖 db.columns,targetOf 只依赖 refPaths/refDbs(都已在列)
  }, [compRows, db.columns, sorts, view.filters, view.filterMode, q, refDbs, refPaths])

  /** 层级树摊平(纯逻辑 db/tree.ts;喂的是筛选 + 排序**之后**的 rows —— 所以用户排序只在兄弟节点之间生效)。
   *  环 / 超深 / 重复行 id → tree.flat=true,渲染自动回到平铺,一行不少。
   *  **孤儿(父被筛/搜没了)当根**,树照渲(裁决理由见 tree.ts 文件头);数量经 data-orphans 出到 DOM 上
   *  —— 没这个属性的话「孤儿当根」与「父格本来就是空的」在 DOM 里逐字节同款,仪器会是假绿。 */
  const tree = useMemo(() => buildTree(rows, treeCol?.id), [rows, treeCol?.id])
  /** 折叠后真正上屏的节点:某节点折叠 → 跳过其后所有更深的节点,直到深度回到它自己这一层。 */
  const treeNodes = useMemo(() => {
    if (tree.flat) return null // 平铺(含没配树列)→ 走原来的 rows 路径,零改动
    const out: typeof tree.nodes = []
    let hideBelow = Number.POSITIVE_INFINITY
    for (const n of tree.nodes) {
      if (n.depth > hideBelow) continue
      hideBelow = Number.POSITIVE_INFINITY
      out.push(n)
      if (n.hasKids && collapsedNodes.has(`${view.id}|${n.row.id}`)) hideBelow = n.depth
    }
    return out
  }, [tree, collapsedNodes, view.id])

  const openPop = (e: ReactMouseEvent, p: Omit<Pop, 'x' | 'y' | 'anchorTop'>): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPop({ ...p, x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }

  /** title 提交(blur/Enter)→ 文件名跟随(renameDb:文件+内部name+全库引用+日历配置一起动)。
   *  onChange 仍只走内存防抖;空名/同名 no-op(空名=文件留旧名,title 显示空由 placeholder 兜)。 */
  const commitTitleRename = (): void => {
    const path = useDbStore.getState().entries[dbRef]?.path
    if (!path) return
    const name = db.name.trim().replace(/[\\/]/g, '')
    const curBase = (path.split(/[\\/]/).pop() || path).replace(/\.db$/i, '')
    if (!name || name === curBase) return
    void renameDb(path, name).catch((e: unknown) => window.alert(t('dbembed.renameFail', { msg: e instanceof Error ? e.message : String(e) })))
  }

  /** 本视图对某列生效的落盘宽:视图带 widths 时**只**看视图(没条目 = 弹性,不回落全局),否则看 column.width。 */
  const widthOf = (c: DbColumn): number | undefined => (view.widths ? view.widths[c.id] : c.width)
  /** 落盘一列宽(undefined = 恢复弹性):当前视图有 widths 写视图,否则写全局 column.width(现状)。
   *  「写哪边」按 m() 拿到的那份数据判(与 reorderCol 同理:回调会重放到重读后的数据上)。 */
  const setColWidth = (colId: string, w: number | undefined): void =>
    m((d) => {
      const v = viewsOf(d).find((x) => x.id === view.id)
      if (v?.widths) {
        const widths = { ...v.widths }
        if (w === undefined) delete widths[colId]
        else widths[colId] = w
        return { ...d, views: viewsOf(d).map((x) => (x.id === v.id ? { ...x, widths } : x)) }
      }
      return { ...d, columns: d.columns.map((c) => (c.id === colId ? { ...c, width: w } : c)) }
    })
  /** 视图菜单「本视图独立列序/列宽」开关:开 = 把当前全局序 / 全局宽拷进视图(从此拖列拖宽只写视图);关 = 清掉两字段回到跟全局。 */
  const toggleOwnCols = (viewId: string): void =>
    m((d) => {
      const v = viewsOf(d).find((x) => x.id === viewId)
      if (!v) return d
      const on = v.order !== undefined || v.widths !== undefined
      const patch: Partial<DbView> = on
        ? { order: undefined, widths: undefined }
        : { order: d.columns.map((c) => c.id), widths: Object.fromEntries(d.columns.filter((c) => c.width !== undefined).map((c) => [c.id, c.width as number])) }
      return { ...d, views: viewsOf(d).map((x) => (x.id === viewId ? { ...x, ...patch } : x)) }
    })

  /** 列宽拖拽:实时改宽即反馈(ponytail:不做 AFFiNE 的全局竖直指示线);pointerup 经与列改名
   *  同一条 mutate 写路径把 width 落进 column / 视图 widths(复用 500ms 防抖落盘);双击命中区清除 width 恢复弹性。 */
  const startResize = (e: ReactPointerEvent, col: DbColumn): void => {
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    // 起点宽:优先已落盘宽,弹性列量 DOM 实际宽 → 首次拖拽从当前观感起步不跳变。
    const startW = liveWidths[col.id] ?? widthOf(col) ?? (grip.parentElement?.getBoundingClientRect().width || 140)
    const startX = e.clientX
    grip.setPointerCapture(e.pointerId)
    grip.setAttribute('data-active', '')
    const onMove = (ev: PointerEvent): void =>
      setLiveWidths((m) => ({ ...m, [col.id]: clampW(startW + ev.clientX - startX) }))
    const onUp = (ev: PointerEvent): void => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeAttribute('data-active')
      setColWidth(col.id, clampW(startW + ev.clientX - startX))
      setLiveWidths((m) => {
        const n = { ...m }
        delete n[col.id]
        return n
      })
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  // 拖过的列固定 px(clamp 100~800),没拖过的保持 minmax 弹性 —— 两者可混排。
  const colW = (c: DbColumn): string => {
    const w = liveWidths[c.id] ?? widthOf(c)
    return w === undefined ? 'minmax(140px, 1fr)' : `${clampW(w)}px`
  }
  const gridCols = `28px ${visCols.map(colW).join(' ')} 36px`
  const popCol = pop ? db.columns.find((c) => c.id === pop.colId) : undefined
  // 从合成后的 rows 找(而非 db.rows):笔记视图的行 id = 笔记路径,db.rows 恒空,
  // 旧写法让笔记视图的 select 选项弹层永远开不出来。
  const popRow = pop?.rowId ? rows.find((r) => r.id === pop.rowId) : undefined
  const popView = pop?.viewId ? views.find((v) => v.id === pop.viewId) : undefined

  return (
    <div className="amx-db">
      <div className="amx-db-head">
        <span className="amx-db-headicon" aria-hidden>{isNoteView ? <DatabaseListViewIcon /> : <DatabaseTableViewIcon />}</span>
        <input
          className="amx-db-name"
          value={db.name}
          placeholder={isNoteView ? t('dbembed.namePlaceholderView') : t('dbembed.namePlaceholderDb')}
          onChange={(e) => m((d) => ({ ...d, name: e.target.value }))}
          onBlur={commitTitleRename}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
        {isNoteView && (
          <button className="amx-db-linkbtn" onClick={(e) => openPop(e, { kind: 'folder' })} title={t('dbembed.folderPick')}>
            <FolderIcon /> {noteFolder || t('dbembed.wholeVault')}
          </button>
        )}
        <span className="amx-db-count">{t('dbembed.rowCount', { n: rows.length })}</span>
      </div>

      <div className="amx-db-viewbar" role="tablist">
        {views.map((v) => (
          <button
            key={v.id}
            className="amx-db-viewtab"
            role="tab"
            aria-selected={v.id === view.id}
            data-active={v.id === view.id || undefined}
            onClick={(e) => { if (v.id === view.id) openPop(e, { kind: 'viewmenu', viewId: v.id }); else pickView(v) }}
            onContextMenu={(e) => { e.preventDefault(); openPop(e, { kind: 'viewmenu', viewId: v.id }) }}
            title={v.id === view.id ? t('dbembed.viewTabHint') : v.name}
          >
            {viewMeta(v.type).icon}
            <span>{v.name}</span>
          </button>
        ))}
        <button className="amx-db-viewadd" onClick={(e) => openPop(e, { kind: 'addview' })} title={t('dbembed.addView')} aria-label="add view">
          <PlusIcon />
        </button>
        <span className="amx-db-viewbar-sp" />
        <button
          className="amx-db-filterbtn"
          data-on={(view.filters?.length ?? 0) > 0 || undefined}
          onClick={(e) => openPop(e, { kind: 'filters' })}
          title={t('dbembed.filterThisView')}
        >
          <FilterIcon />
          {t('dbembed.filter')}{(view.filters?.length ?? 0) > 0 && ` ${view.filters!.length}`}
        </button>
        <input className="amx-db-search" placeholder={t('dbembed.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('dbembed.searchRows')} />
        <button className="amx-db-iconbtn" onClick={() => openDb(dbPath)} title={t('dbembed.openAsPage')} aria-label="open as page"><ExternalLink size={15} /></button>
        {/* 导出 CSV:导的是**当前视图看到的那张表**(visCols × 已筛选/排序的 rows),不是整表。
            移动端 csvExportMode()='off' → 整个按钮不渲染(WebView 里 `<a download>` 不落盘,留个死按钮更糟)。 */}
        {csvExportMode() !== 'off' && (
          <button
            className="amx-db-iconbtn"
            onClick={() => void exportCsvFile(db.name, buildDbCsv(visCols, rows, { targetDb: refDbByPath }))
              .catch((e: unknown) => window.alert(t('dbembed.exportFail', { msg: e instanceof Error ? e.message : String(e) })))}
            title={t('dbembed.exportCsv', { cols: visCols.length, rows: rows.length })}
            aria-label="export csv"
          ><Download size={15} /></button>
        )}
        <button className="amx-db-iconbtn" onClick={(e) => openPop(e, { kind: 'viewmenu', viewId: view.id })} title={t('dbembed.viewSettings')} aria-label="view settings"><Settings2 size={15} /></button>
        {/* 表单视图没有通用「新建」:直接 addRow() 会绕过表单的必填与默认值,建行只走 FormBody 的提交(Codex 评审抓的) */}
        {view.type !== 'form' && <button className="amx-db-newbtn" onClick={() => addRow()} title={t('dbembed.new')}><Plus size={14} /> {t('dbembed.new')}</button>}
      </div>

      {db.columns.length === 0 ? (
        <div className="amx-db-state">
          {t('dbembed.noColumns')}
          <button className="amx-db-linkbtn" onClick={addCol}>{t('dbembed.addColumn')}</button>
        </div>
      ) : view.type === 'kanban' ? (
        <KanbanBody db={db} rows={rows} view={view} visCols={visCols} setCell={setCell} addRow={addRow} openRow={openRow} rowTitle={rowTitle} addStatusCol={addStatusCol} />
      ) : view.type === 'calendar' ? (
        <CalendarBody db={db} rows={rows} view={view} addRow={addRow} openRow={openRow} rowTitle={rowTitle} addDateCol={addDateCol} />
      ) : view.type === 'gallery' ? (
        <GalleryBody db={db} rows={rows} visCols={visCols} addRow={addRow} openRow={openRow} rowTitle={rowTitle} coverOf={coverOf} />
      ) : view.type === 'chart' ? (
        <ChartViewBody db={db} rows={rows} view={view} kindOf={kindOf} />
      ) : view.type === 'gantt' ? (
        <GanttBody db={db} rows={rows} view={view} openRow={openRow} rowTitle={rowTitle} addDateCol={addDateCol} patchView={(p) => patchView(view.id, p)} colIcon={(ct) => colMeta(ct).icon} />
      ) : view.type === 'form' ? (
        <FormBody
          key={view.id}
          db={db}
          view={view}
          colIcon={(ct) => colMeta(ct).icon}
          renderCell={(row, col, sc, openOptions) => <Cell row={row} col={col} pagePath={pagePath} env={cellEnv} setCell={sc} openOptions={openOptions} />}
          renderOptions={(p) => <OptionsPop x={p.x} y={p.y} col={p.col} row={p.row} setCell={p.setCell} createOption={createOption} onClose={p.onClose} />}
          onSubmit={(draft) => addRow(draft)}
          onGoTable={() => { const tv = views.find((v) => !['kanban', 'calendar', 'gallery', 'chart', 'form', 'gantt'].includes(v.type)); if (tv) pickView(tv) }}
        />
      ) : (
        <div
          className="amx-db-scroll"
          data-tree={treeCol ? (tree.flat ? `flat:${tree.reason ?? ''}` : 'tree') : undefined}
          data-orphans={treeCol && tree.orphanIds.length ? String(tree.orphanIds.length) : undefined}
        >
          <div className="amx-db-row amx-db-hrow" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {visCols.map((col) => {
              const cs = sortOf(col.id)
              const typeLabel = t(colMeta(col.type).labelKey)
              return (
                <div
                  className="amx-db-th"
                  key={col.id}
                  data-drop={colDrag && colDrag.overId === col.id && colDrag.id !== col.id ? (colDrag.after ? 'right' : 'left') : undefined}
                  onDragOver={(e) => {
                    if (!colDrag) return // 别劫持外面的拖入(OS 文件、块拖拽)——只认本表头发起的那一次
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    const after = isIdentity(col.id) ? true : dropAfterX(e.clientX, r)
                    if (colDrag.overId !== col.id || colDrag.after !== after) setColDrag({ ...colDrag, overId: col.id, after })
                  }}
                  onDrop={(e) => {
                    if (!colDrag) return
                    e.preventDefault()
                    // ⚠️ 落点按 **drop 自己的坐标**现算,不吃 colDrag.after —— 那是上一次 dragover
                    // 异步写进 state 的,快速掠过中线后立刻松手会用到旧值(Codex 抓的)。
                    // colDrag.after 只负责画预览竖线,不参与落盘判定。
                    reorderCol(colDrag.id, col.id, dropAfterX(e.clientX, e.currentTarget.getBoundingClientRect()))
                    setColDrag(null)
                  }}
                >
                  {/* draggable 挂在按钮上而不是整个 .amx-db-th:宽度拖杆是它的兄弟节点,整格可拖会和
                      拖宽抢 mousedown。放不动的首列不给 draggable(浏览器自己就不会起拖)。 */}
                  <button
                    className="amx-db-thbtn"
                    draggable={!isIdentity(col.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', col.id)
                      setColDrag({ id: col.id, overId: col.id, after: false })
                    }}
                    onDragEnd={() => setColDrag(null)}
                    onClick={(e) => openPop(e, { kind: 'colmenu', colId: col.id })}
                    title={isIdentity(col.id) ? t('dbembed.colMenuHintFixed', { type: typeLabel }) : t('dbembed.colMenuHint', { type: typeLabel })}
                  >
                    <span className="amx-db-th-icon" aria-hidden>{colMeta(col.type).icon}</span>
                    <span className="amx-db-th-name">{col.name}</span>
                    {cs && <span className="amx-db-th-sort">{cs.dir === 'asc' ? '↑' : '↓'}{sorts.length > 1 ? cs.idx + 1 : ''}</span>}
                  </button>
                  <div
                    className="amx-db-resize"
                    onPointerDown={(e) => startResize(e, col)}
                    onDoubleClick={() => setColWidth(col.id, undefined)}
                    title={t('dbembed.resizeHint')}
                  />
                </div>
              )
            })}
            <button className="amx-db-addcol" onClick={addCol} title={t('dbembed.addColumnTitle')}>＋</button>
          </div>

          {(() => {
            /** 树节点(平铺 / 非树时为 null):只影响首个数据格里的缩进条 + 折叠钮,行本身的结构一格不动。 */
            const renderRow = (row: DbRow, node?: { depth: number; hasKids: boolean } | null): ReactNode => (
              <div
                className="amx-db-row"
                key={row.id}
                data-row={row.id}
                data-depth={node ? node.depth : undefined}
                data-haskids={node?.hasKids || undefined}
                style={{ gridTemplateColumns: gridCols }}
                data-drop={drag?.overId === row.id ? (drag.after ? 'below' : 'above') : undefined}
                onDragOver={canReorder ? (e) => {
                  if (!drag) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = dropAfter(e.clientY, r)
                  if (drag.overId !== row.id || drag.after !== after) setDrag({ ...drag, overId: row.id, after })
                } : undefined}
                onDrop={canReorder ? (e) => {
                  e.preventDefault()
                  if (drag) reorderRow(drag.id, row.id, drag.after)
                  setDrag(null)
                } : undefined}
              >
                {/* 手柄和删除同处**一个**网格单元(首列 28px):行首必须只有一个子元素,
                    否则表头/统计行(各自只放一个占位 div)与数据行的列就错开了。
                    手柄单独 draggable、整行不 draggable —— 整行可拖会让单元格里的文字选不中。 */}
                <div className="amx-db-rowgutter">
                  <div
                    className="amx-db-rowdrag"
                    draggable={canReorder}
                    title={canReorder ? t('dbembed.dragRow') : t('dbembed.dragRowBlocked')}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.id); setDrag({ id: row.id, overId: row.id, after: false }) }}
                    onDragEnd={() => setDrag(null)}
                  >
                    ⠿
                  </div>
                  <button className="amx-db-rowdel" onClick={() => delRow(row.id)} title={t('dbembed.deleteRow')} aria-label="delete row">✕</button>
                </div>
                {visCols.map((col, ci) => (
                  <div className="amx-db-cell" key={col.id} data-coltype={resolveBaseType(col.type)}>
                    {/* 缩进条 + 折叠钮只挂在**首个数据格**(标题列):行首 28px 那格已被拖柄/删除占满,
                        再塞东西会让表头/统计行与数据行的网格轨道对不上(E9 那条对齐断言守的就是它)。 */}
                    {node && ci === 0 && (
                      <span className="amx-db-treelead" style={{ paddingLeft: node.depth * 14 }}>
                        {node.hasKids ? (
                          <button
                            className="amx-db-treecaret"
                            data-row={row.id}
                            data-open={!collapsedNodes.has(`${view.id}|${row.id}`) || undefined}
                            aria-expanded={!collapsedNodes.has(`${view.id}|${row.id}`)}
                            title={t('dbembed.treeToggle')}
                            onClick={() => setCollapsedNodes((s) => {
                              const n = new Set(s)
                              const k = `${view.id}|${row.id}`
                              if (n.has(k)) n.delete(k)
                              else n.add(k)
                              return n
                            })}
                          >
                            {/* 用矢量 ChevronRight 而不是 `▸` 字形:10-11px 的 ▸ 在真截图里就是个句点大小的小点,
                                根本看不出是个可点的控件(2026-09-02 自查截图抓到的,几何断言全绿也照样漏)。 */}
                            <ChevronRight size={13} strokeWidth={2.5} aria-hidden />
                          </button>
                        ) : (
                          <span className="amx-db-treedot" aria-hidden />
                        )}
                      </span>
                    )}
                    <Cell row={row} col={col} pagePath={pagePath} env={cellEnv} setCell={setCell} openOptions={(e) => openPop(e, { kind: 'options', colId: col.id, rowId: row.id })} />
                  </div>
                ))}
                <div />
              </div>
            )
            // 层级树:按树序渲染(父在前、子紧随、折叠隐藏后代)。treeNodes=null 即 buildTree 判了平铺 —— 走下面的老路。
            if (treeNodes) {
              return (
                <>
                  {treeNodes.map((n) => renderRow(n.row, n))}
                  <button className="amx-db-addrow" onClick={() => addRow()}>{t('dbembed.addRow')}</button>
                </>
              )
            }
            if (!tableGroupCol) {
              return (
                <>
                  {rows.map((r) => renderRow(r))}
                  <button className="amx-db-addrow" onClick={() => addRow()}>{t('dbembed.addRow')}</button>
                </>
              )
            }
            // 分组渲染。两种键源:① 单选列 —— 泳道语义与看板一致(选项序 + 未分组兜底,空组照样出现);
            // ② 日期列(2.9)—— 键 = 落盘串前 10/7 位(纯逻辑 db/groupDate.ts,不做时区换算),按键升序、
            //    未设置恒最后、空组不凭空造。折叠态两者共用 collapsedGroups,仅本嵌入局部。
            const isDateGroup = isDateish(tableGroupCol)
            const opts = tableGroupCol.options ?? []
            const groups: Array<{ key: string; label: ReactNode; rows: DbRow[]; add?: Record<string, CellValue> }> = isDateGroup
              ? groupRowsByDate(rows, tableGroupCol.id, groupUnit).map((g) => ({
                key: g.key || '__none',
                label: g.key
                  ? <span className={`amx-db-chip ${chipClass(g.key)}`}>{g.key}</span>
                  : <span className="amx-db-lane-none">{t('dbembed.groupNone')}</span>,
                rows: g.rows,
                // 组内新建行预填该组的日期:只有日档的键(YYYY-MM-DD)是合法日期值;月档的 YYYY-MM 不是,
                // 盖章列(created)更是写了也会被 addRow 压掉 —— 两种情形都不预填。
                add: g.key && groupUnit === 'day' && tableGroupCol.type !== 'created' ? { [tableGroupCol.id]: g.key } : undefined,
              }))
              : [...opts, null].map((opt) => ({
                key: opt ?? '__none',
                label: opt ? <span className={`amx-db-chip ${chipClass(opt)}`}>{opt}</span> : <span className="amx-db-lane-none">{t('dbembed.laneNone')}</span>,
                rows: rows.filter((r) => {
                  const v = coerceForDisplay(r.cells[tableGroupCol.id], 'select') as string
                  return opt === null ? !v || !opts.includes(v) : v === opt
                }),
                add: opt ? { [tableGroupCol.id]: opt } : undefined,
              }))
            return groups.map((g) => {
              const gKey = `${view.id}|${g.key}`
              const collapsed = collapsedGroups.has(gKey)
              return (
                <div key={gKey} className="amx-db-group" data-group={g.key}>
                  <button
                    className="amx-db-grouphead"
                    onClick={() => setCollapsedGroups((s) => {
                      const n = new Set(s)
                      if (n.has(gKey)) n.delete(gKey)
                      else n.add(gKey)
                      return n
                    })}
                    aria-expanded={!collapsed}
                  >
                    <span className="amx-db-groupcaret" data-open={!collapsed || undefined}>▸</span>
                    {g.label}
                    <span className="amx-db-lane-count">{g.rows.length}</span>
                  </button>
                  {!collapsed && g.rows.map((r) => renderRow(r))}
                  {!collapsed && (
                    <button className="amx-db-addrow" onClick={() => addRow(g.add)}>{t('dbembed.addRow')}</button>
                  )}
                </div>
              )
            })
          })()}

          <div className="amx-db-row amx-db-statsrow" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {visCols.map((col) => {
              const stat = view.stats?.[col.id]
              const kind = kindOf(col.id) ?? 'text'
              return (
                <button
                  key={col.id}
                  className="amx-db-stat"
                  data-on={stat || undefined}
                  onClick={(e) => openPop(e, { kind: 'stat', colId: col.id })}
                  title={t('dbembed.statTitle')}
                >
                  {stat ? `${STAT_LABEL[stat] ?? stat} ${computeStat(rows, col.id, kind, stat)}` : t('dbembed.stat')}
                </button>
              )
            })}
            <div />
          </div>
        </div>
      )}

      {pop && popCol && pop.kind === 'colmenu' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <ColMenu
            key={popCol.id} // 引用列的正/反向模式是本地 state:换列打开菜单必须重挂,别把上一列的模式带过来
            col={popCol}
            sort={sortOf(popCol.id)?.dir ?? null}
            onSort={(dir) => { setColSort(popCol.id, dir); setPop(null) }}
            onRename={(name) => renameCol(popCol, name)}
            onSetType={(type) => patchCol(popCol.id, { type })}
            onDelete={() => { delCol(popCol.id); setPop(null) }}
            locked={isIdentity(popCol.id)}
            onMove={(dir) => moveColBy(popCol.id, dir)}
            canMoveLeft={!isIdentity(popCol.id) && visCols.findIndex((c) => c.id === popCol.id) > 1}
            canMoveRight={!isIdentity(popCol.id) && visCols.findIndex((c) => c.id === popCol.id) < visCols.length - 1}
            columns={db.columns}
            dbPath={dbPath}
            dbFiles={dbFiles}
            targetColsOf={targetColsOf}
            targetDbOf={(p) => useDbStore.getState().entries[p]?.data ?? null}
            onPatchCol={(patch) => patchCol(popCol.id, patch)}
          />
        </PopShell>
      )}
      {pop && popCol && popRow && pop.kind === 'options' && (
        <OptionsPop x={pop.x} y={pop.y} col={popCol} row={popRow} setCell={setCell} createOption={createOption} onClose={() => setPop(null)} />
      )}
      {pop && pop.kind === 'folder' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <FolderPopover current={noteFolder ?? ''} onPick={(f) => void setFolder(f)} />
        </PopShell>
      )}
      {pop && pop.kind === 'viewmenu' && popView && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <ViewMenu
            view={popView}
            columns={db.columns}
            sorts={sorts}
            chartGroupCol={popView.type === 'chart' ? resolveChartGroupCol(db, popView)?.id : undefined}
            treeCols={treeColsOf(db.columns, [dbPath, dbRef])}
            onCycleSort={cycleSort}
            onClearSorts={clearSorts}
            onRename={(name) => patchView(popView.id, { name })}
            onPatch={(patch) => patchView(popView.id, patch)}
            onPickGroupBy={(id) => patchView(popView.id, { groupBy: id })}
            onPickDateCol={(id) => patchView(popView.id, { dateCol: id })}
            onToggleHidden={(colId) => {
              const cur = popView.hidden ?? []
              const next = cur.includes(colId) ? cur.filter((x) => x !== colId) : [...cur, colId]
              patchView(popView.id, { hidden: next.length ? next : undefined })
            }}
            onToggleOwnCols={() => toggleOwnCols(popView.id)}
            onOpenFilters={() => setPop({ kind: 'filters', x: pop.x, y: pop.y })}
            onOpenCalendar={() => setPop({ kind: 'calendar', x: pop.x, y: pop.y })}
            calendarActive={!!memberOf(vault, calByVault, dbPath)}
            onDelete={views.length > 1 ? () => delView(popView.id) : undefined}
          />
        </PopShell>
      )}
      {pop && pop.kind === 'calendar' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <MemberColPicker
            dbName={db.name}
            columns={db.columns}
            initial={memberOf(vault, calByVault, dbPath)}
            onCancel={() => setPop(null)}
            onConfirm={(dateCol, checkboxCol) => { addMember(vault, dbPath, dateCol, checkboxCol); setPop(null) }}
          />
        </PopShell>
      )}
      {pop && pop.kind === 'filters' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <FiltersPop
            view={view}
            columns={db.columns}
            kindOf={kindOf}
            targetOf={targetOf}
            onChange={(filters) => patchView(view.id, { filters: filters.length ? filters : undefined })}
            onMode={(m) => patchView(view.id, { filterMode: m === 'or' ? 'or' : undefined })}
          />
        </PopShell>
      )}
      {pop && popCol && pop.kind === 'stat' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <div className="amx-db-pop-sec">{t('dbembed.statSec', { col: popCol.name })}</div>
          <div className="amx-db-pop-list">
            <button
              className="amx-db-opt"
              onClick={() => {
                const s = { ...view.stats }
                delete s[popCol.id]
                patchView(view.id, { stats: Object.keys(s).length ? s : undefined })
                setPop(null)
              }}
            >
              {t('dbembed.statNone')}
              {!view.stats?.[popCol.id] && <span className="amx-db-opt-check">✓</span>}
            </button>
            {statOptionsFor(kindOf(popCol.id) ?? 'text').map((s) => (
              <button key={s} className="amx-db-opt" onClick={() => { patchView(view.id, { stats: { ...view.stats, [popCol.id]: s } }); setPop(null) }}>
                {STAT_LABEL[s]}
                {view.stats?.[popCol.id] === s && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
          </div>
        </PopShell>
      )}
      {pop && pop.kind === 'addview' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <div className="amx-db-pop-sec">{t('dbembed.addView')}</div>
          <div className="amx-db-pop-list">
            {(Object.keys(VIEW_META) as DbViewType[]).map((vt) => (
              <button key={vt} className="amx-db-opt" onClick={() => addView(vt)}>
                <span className="amx-db-th-icon" aria-hidden>{VIEW_META[vt].icon}</span>
                {t(VIEW_META[vt].labelKey)}
              </button>
            ))}
          </div>
        </PopShell>
      )}
      {pop && pop.kind === 'row' && popRow && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <RowEditor
            db={db}
            row={popRow}
            pagePath={pagePath}
            env={cellEnv}
            setCell={setCell}
            createOption={createOption}
            onDelete={() => { delRow(popRow.id); setPop(null) }}
          />
        </PopShell>
      )}
    </div>
  )
}

// ── 单元格(七/八类型) ────────────────────────────────────────────────────────

const CELL_WIKI_RE = /(\[\[[^\]\n]+\]\])/
/** 光标处一对**未闭合**的 [[(中文输入法打出的【【同收):补全触发判据 + 选中后被替换的那一段。 */
const WIKI_OPEN_RE = /(?:\[\[|【【)([^[\]【】\n]*)$/

function Cell({
  row,
  col,
  pagePath,
  env,
  setCell,
  openOptions,
}: {
  row: DbRow
  col: DbColumn
  pagePath: string
  env: CellEnv
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  openOptions: (e: ReactMouseEvent) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false) // text 含 [[ ]] 时的展示/编辑切换 + url 编辑态
  // [[ 补全弹层;caret = 触发时的光标位置(替换只作用于它之前那段未闭合的 [[…)。
  const [wikiPick, setWikiPick] = useState<{ x: number; y: number; anchorTop: number; caret: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null) // 关掉补全弹层后把焦点还给单元格(autoFocus 只在挂载时生效)
  const ps = useScopedPageStore() // 单元格里点双链要落在自己这半屏
  const cancelRef = useRef(false)
  const custom = getPropertyType(col.type)
  const v = coerceForDisplay(row.cells[col.id], resolveBaseType(col.type))

  /** [[目标]] 点击:linkTarget 剥 |别名 与 #锚点(与 Markdown 块同语义);已存在页面优先
   *  (v2.1 这类带点号页名不被误判为附件),未命中且带非 .md/.db 扩展名才当附件系统打开
   *  (.db 落给 openWikiLink 的文件分支 → 应用内 db tab,不再被系统程序打开原始 JSON)。 */
  const openLink = (raw: string): void => {
    const target = linkTarget(raw)
    const st = ps.getState()
    if (resolvePageName(target, st.pages, pagePath)) return void st.openWikiLink(target.replace(/\.md$/i, ''), pagePath)
    if (/\.[a-z0-9]{1,8}$/i.test(target) && !/\.(md|db)$/i.test(target)) return void amadeus.openAttachment(pagePath, target)
    st.openWikiLink(target.replace(/\.md$/i, ''), pagePath) // 未解析 → 询问创建(源 = 本 .db 所在处)
  }

  // 自定义注册类型:交给注册表的 Cell(value 已按 baseType 折算)。
  if (custom) {
    const Custom = custom.Cell
    return <Custom value={v} column={col} onChange={(nv) => setCell(row.id, col.id, nv)} />
  }

  switch (col.type) {
    case 'formula':
    case 'lookup': {
      // 投影列(可编辑反向关联):照关联表 cell 渲 chip + picker,写口是目标表(见 BackLinkCell)
      if (isLinksProjection(col)) return <BackLinkCell row={row} col={col} env={env} setCell={setCell} />
      // 计算列:物化值只读展示(#错误/#循环 是哨兵,标红;公式源挂 title 便于排查)。
      const raw = row.cells[col.id]
      // 结果是数字时照本列的显示格式走(公式列/引用聚合也能配 ¥ 与小数位);其余形态原样。
      const s = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : typeof raw === 'boolean' ? (raw ? '✓' : '✗') : typeof raw === 'number' ? formatNumber(raw, col) : String(raw)
      const bad = s === '#错误' || s === '#循环'
      return (
        <span className="amx-db-computed" data-err={bad || undefined} title={bad && col.type === 'formula' ? col.formula : undefined}>
          {s || <span className="amx-db-blank">–</span>}
        </span>
      )
    }
    case 'rowlink':
      return <RowLinkCell row={row} col={col} env={env} setCell={setCell} />
    case 'file':
      return <FileCell row={row} col={col} env={env} setCell={setCell} />

    case 'text': {
      const s = v as string
      // 含 [[链接]] 且非编辑态 → 富文本展示(链接可点);点击其余区域 / ✎ 进入编辑。
      // 补全弹层开着时不切:弹层里的搜索框会抢焦点 → 输入框失焦 → 整支换成展示态,弹层跟着被卸掉。
      if (!editing && !wikiPick && CELL_WIKI_RE.test(s)) {
        return (
          <div className="amx-db-urlcell" onClick={() => setEditing(true)}>
            <span className="amx-db-richtext">
              {s.split(CELL_WIKI_RE).map((seg, i) => {
                const m = /^\[\[([^\]\n]+)\]\]$/.exec(seg)
                if (!m) return <span key={i}>{seg}</span>
                const inner = m[1]
                const label = (inner.split('|')[1] ?? inner.split('|')[0]).trim()
                return (
                  <button key={i} className="amx-db-wikilink" onClick={(e) => { e.stopPropagation(); openLink(inner) }} title={inner}>
                    {label}
                  </button>
                )
              })}
            </span>
            <button className="amx-db-edit" onClick={(e) => { e.stopPropagation(); setEditing(true) }} title={t('dbembed.edit')} aria-label="edit cell">✎</button>
          </div>
        )
      }
      const put = (next: string): void => setCell(row.id, col.id, next === '' ? undefined : next)
      return (
        <>
          <input
            ref={inputRef}
            className="amx-db-input"
            autoFocus={editing || undefined}
            value={s}
            onChange={(e) => {
              const next = e.target.value
              put(next)
              // 判据只看**光标之前**那一段:在已有文字中间插 [[ 也得弹(整串结尾还有后文,拿全串判会漏)。
              const caret = e.target.selectionStart ?? next.length
              if (WIKI_OPEN_RE.test(next.slice(0, caret))) {
                const r = e.target.getBoundingClientRect()
                setWikiPick({ x: r.left, y: r.bottom + 4, anchorTop: r.top, caret })
              } else setWikiPick(null)
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false)
              // 中文输入法打出来的是全角【】,归一成半角才是双链(否则用户「打了却不成链接」)。
              const fixed = s.replace(/【【([^】\n]+)】】/g, '[[$1]]')
              if (fixed !== s) put(fixed)
            }}
            // Enter/Esc = 提交并离开:没有这一步,链接只在「点了别处」之后才现形。
            // ⚠️ 组合态(拼音选词)的 Enter 是「确认候选词」,吞掉它 = 中文用户打一半就被踢出单元格。
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
          />
          {wikiPick && (
            <RelationPicker
              x={wikiPick.x}
              y={wikiPick.y}
              anchorTop={wikiPick.anchorTop} // 下方放不下时翻到输入框**上沿之上**,别盖住正在打字的格子
              onClose={() => { setWikiPick(null); inputRef.current?.focus() }}
              onPick={(inner) => {
                setWikiPick(null)
                setEditing(false) // 直接回展示态,选完立刻看见链接
                // 只替换光标前那段未闭合的 [[…,光标之后的原文原样保留。
                const head = s.slice(0, wikiPick.caret).replace(WIKI_OPEN_RE, inner ? `[[${inner}]]` : '')
                put(head + s.slice(wikiPick.caret))
              }}
            />
          )}
        </>
      )
    }
    case 'number': {
      const n = v as number | null
      // 配过显示格式(小数位/单位)的列:只读态显示格式化后的串,**点一下才进编辑态并回到原始值**。
      // ⚠️ 这一条是正确性不是观感 —— 编辑态若显示「¥1,234.00元」,用户一点就把这串当新值存回去了
      //(number input 甚至解析不出来 → 整格被清空)。没配格式的列走原路径,观感与落地前逐字相同。
      if (hasNumberFormat(col) && !editing) {
        return (
          <span className="amx-db-numfmt" onClick={() => setEditing(true)} title={t('dbembed.clickToEdit')}>
            {n === null ? <span className="amx-db-blank">{t('dbembed.blank')}</span> : formatNumber(n, col)}
          </span>
        )
      }
      return (
        <input
          className="amx-db-input"
          type="number"
          inputMode="decimal"
          autoFocus={editing || undefined}
          value={n ?? ''}
          onChange={(e) => {
            const s = e.target.value
            if (s === '') return setCell(row.id, col.id, undefined)
            const num = Number(s)
            if (Number.isFinite(num)) setCell(row.id, col.id, num)
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }}
        />
      )
    }
    case 'checkbox':
      return (
        <input
          className="amx-db-checkbox"
          type="checkbox"
          checked={v === true}
          onChange={(e) => setCell(row.id, col.id, e.target.checked ? true : undefined)}
        />
      )
    case 'date':
      return (
        <input
          className="amx-db-input"
          type="date"
          value={v as string}
          onChange={(e) => setCell(row.id, col.id, e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'select': {
      const s = v as string
      return (
        <button className="amx-db-cellbtn" onClick={openOptions}>
          {s ? <span className={`amx-db-chip ${chipClass(s)}`}>{s}</span> : <span className="amx-db-blank">{t('dbembed.blank')}</span>}
        </button>
      )
    }
    case 'multiselect': {
      const arr = v as string[]
      return (
        <button className="amx-db-cellbtn" onClick={openOptions}>
          {arr.length ? arr.map((tag) => <span key={tag} className={`amx-db-chip ${chipClass(tag)}`}>{tag}</span>) : <span className="amx-db-blank">{t('dbembed.blank')}</span>}
        </button>
      )
    }
    case 'url': {
      const s = v as string
      if (editing) {
        const commit = (raw: string): void => {
          setEditing(false)
          if (cancelRef.current) { cancelRef.current = false; return }
          let url = raw.trim()
          // 形如域名(a.b)且无 scheme → 便利补 https://
          if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) url = `https://${url}`
          setCell(row.id, col.id, url === '' ? undefined : url)
        }
        return (
          <input
            className="amx-db-input"
            autoFocus
            defaultValue={s}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') { cancelRef.current = true; (e.target as HTMLInputElement).blur() }
            }}
          />
        )
      }
      // 只 linkify http(s)(恶意 scheme 双保险:这里不放行 + 主进程 windowOpenHandler 只放 http/https)
      const href = /^https?:\/\//i.test(s) ? s : ''
      return (
        <div className="amx-db-urlcell">
          {href ? (
            <a className="amx-db-url" href={href} target="_blank" rel="noreferrer" title={s}>{s}</a>
          ) : (
            <span className="amx-db-urltext">{s}</span>
          )}
          <button className="amx-db-edit" onClick={() => setEditing(true)} title={t('dbembed.editUrl')} aria-label="edit url">✎</button>
        </div>
      )
    }
    case 'page': {
      // 笔记视图身份列:显示 = 笔记名(点开笔记);✎ 进入编辑 → 提交即重命名文件。
      const s = v as string
      if (editing) {
        const commit = (raw: string): void => {
          setEditing(false)
          if (cancelRef.current) { cancelRef.current = false; return }
          const name = raw.trim()
          if (name && name !== s) setCell(row.id, col.id, name)
        }
        return (
          <input
            className="amx-db-input"
            autoFocus
            defaultValue={s}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') { cancelRef.current = true; (e.target as HTMLInputElement).blur() }
            }}
          />
        )
      }
      return (
        <div className="amx-db-urlcell">
          <button className="amx-db-wikilink amx-db-pagename" onClick={() => void ps.getState().loadPage(row.id)} title={t('dbembed.openNote', { name: s })}>
            {s || t('dbembed.untitled')}
          </button>
          <button className="amx-db-edit" onClick={() => setEditing(true)} title={t('dbembed.renameNote')} aria-label="rename note">✎</button>
        </div>
      )
    }
    default:
      // 未知类型(无注册项 + 非 primitive):按文本兜底,永不空白/丢数据。
      return (
        <input
          className="amx-db-input"
          value={typeof v === 'string' ? v : v == null ? '' : String(v)}
          onChange={(e) => setCell(row.id, col.id, e.target.value === '' ? undefined : e.target.value)}
        />
      )
  }
}

/** 关联表单元格:cell 存目标 .db 的行 id(单选 string / 多选 string[]);每个 id 一枚 chip 显示目标行标题,
 *  点开选择器换行(多选 = 切换、不关弹层),↗ 打开目标表。
 *  ⚠️ 数组值必须先归一再渲染 —— 旧版按 `typeof === 'string'` 判,数组会落到「空」:数据在盘上、界面说空。 */
function RowLinkCell({ row, col, env, setCell }: {
  row: DbRow
  col: DbColumn
  env: CellEnv
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
}) {
  const { t } = useI18n()
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const tgt = env.targetOf(col)
  if (!col.refDb) return <span className="amx-db-blank" title={t('dbembed.pickTargetDb')}>{t('dbembed.noTargetDb')}</span>
  const ids = rowLinkIds(row.cells[col.id])
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  /** 多选切换:读回当前数组、增删该 id,**造新数组**写回(dbAggregateStore 复制/恢复行是浅拷贝 cells,
   *  原地 push/splice 会连带改到副本行);空了写 undefined(删键)。 */
  const toggle = (id: string): void => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    setCell(row.id, col.id, next.length ? next : undefined)
  }
  return (
    <>
      <div className="amx-db-urlcell">
        <button className="amx-db-cellbtn" onClick={open} title={tgt ? t('dbembed.relateRows', { name: tgt.db.name }) : t('dbembed.targetLoading')}>
          {ids.length === 0 ? <span className="amx-db-blank">{t('dbembed.blank')}</span>
            : ids.map((id) => {
              const hit = tgt ? tgt.db.rows.find((r) => r.id === id) : null
              const label = hit && tgt ? linkLabel(tgt.db, hit, col.titleCol) : ''
              return hit
                ? <span key={id} className={`amx-db-chip ${chipClass(label)}`}>{label}</span>
                : <span key={id} className="amx-db-blank">{tgt ? t('dbembed.lost') : '…'}</span>
            })}
        </button>
        <button className="amx-db-edit" onClick={() => openDb(col.refDb!)} title={t('dbembed.openTargetDb')} aria-label="open target db">↗</button>
      </div>
      {pos && tgt && (
        <RowLinkPicker
          x={pos.x}
          y={pos.y}
          anchorTop={pos.anchorTop}
          target={tgt.db}
          multi={!!col.multiple}
          titleCol={col.titleCol}
          refFilter={col.refFilter}
          refFilterMode={col.refFilterMode}
          selected={ids}
          onClose={() => setPos(null)}
          onPick={(id) => {
            if (col.multiple) {
              if (id === null) { setCell(row.id, col.id, undefined); setPos(null) } // 清空关联
              else toggle(id)
              return
            }
            setCell(row.id, col.id, id ?? undefined)
            setPos(null)
          }}
        />
      )}
    </>
  )
}

/** 投影列单元格(真双向关联的反向侧):值 = 目标表里 backCol 指回本行的行 id 数组(compRows 物化,磁盘无 cell),
 *  每个 id 一枚 chip(文案走目标表 titleCol,与关联表 cell 同一套 linkLabel);点开选择器列**目标表**的行(候选可用本列 refFilter 限定),
 *  永远是多选切换 —— 多个目标行都可以指回本行,backCol 单值时 add = 把那一行的关联覆盖成本行(backlink.ts 口径)。
 *  写口:env.backLinkEdit(对目标表一次 mutate);「清空关联」走 setCell(undefined) → 专用写口全摘。配置半残 → 提示不渲 chip。 */
function BackLinkCell({ row, col, env, setCell }: {
  row: DbRow
  col: DbColumn
  env: CellEnv
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
}) {
  const { t } = useI18n()
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const issue = env.projectionIssue(col)
  if (issue) return <span className="amx-db-blank" title={issue}>{t('dbembed.projectionPending')}</span>
  const tgt = env.targetOf(col)
  const ids = rowLinkIds(row.cells[col.id])
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  return (
    <>
      <div className="amx-db-urlcell" data-backlink>
        <button className="amx-db-cellbtn" onClick={open} title={tgt ? t('dbembed.backRows', { name: tgt.db.name }) : t('dbembed.targetLoading')}>
          {ids.length === 0 ? <span className="amx-db-blank">{t('dbembed.blank')}</span>
            : ids.map((id) => {
              const hit = tgt ? tgt.db.rows.find((r) => r.id === id) : null
              const label = hit && tgt ? linkLabel(tgt.db, hit, col.titleCol) : ''
              return hit
                ? <span key={id} className={`amx-db-chip ${chipClass(label)}`}>{label}</span>
                : <span key={id} className="amx-db-blank">{tgt ? t('dbembed.lost') : '…'}</span>
            })}
        </button>
        <button className="amx-db-edit" onClick={() => openDb(col.refDb!)} title={t('dbembed.openTargetDb')} aria-label="open target db">↗</button>
      </div>
      {pos && tgt && (
        <RowLinkPicker
          x={pos.x}
          y={pos.y}
          anchorTop={pos.anchorTop}
          target={tgt.db}
          multi
          titleCol={col.titleCol}
          refFilter={col.refFilter}
          refFilterMode={col.refFilterMode}
          selected={ids}
          onClose={() => setPos(null)}
          onPick={(id) => {
            if (id === null) { setCell(row.id, col.id, undefined); setPos(null); return } // 清空:全部目标行不再指回本行
            env.backLinkEdit(col, row.id, id, !ids.includes(id)) // 切换一行:对侧表一次 mutate,不关弹层
          }}
        />
      )}
    </>
  )
}

/** 目标表行选择器:先按列的 refFilter 限定候选(对目标表**磁盘行**筛,算子与视图筛选同一套),再按芯片文案模糊搜索
 *  (与 RelationPicker 同观感,但目标是行不是笔记)。已选但被 refFilter 剔掉的行不在列表里(chip 仍显示,清空走「清空关联」)。
 *  multi = 多选模式:已选项置顶并打勾,点击/Enter 只切换、不关弹层(关闭交给点外/Esc);单选保持原样。 */
function RowLinkPicker({ x, y, anchorTop, target, multi, titleCol, refFilter, refFilterMode, selected, onPick, onClose }: {
  x: number
  y: number
  anchorTop?: number
  target: DbFile
  multi?: boolean
  /** 芯片显示列 / 候选限定(都来自 rowlink 列配置;缺 = 首列 / 全部行)。 */
  titleCol?: string
  refFilter?: DbViewFilter[]
  refFilterMode?: string
  /** 当前已选的行 id(多选打勾用;单选也可传,标出当前行)。 */
  selected?: string[]
  onPick: (rowId: string | null) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const sel = new Set(selected ?? [])
  // 无搜索词时已选项置顶再截 12:否则多选下已选但不在前 12 的行看不见、也取消不了。
  // 有搜索词就不置顶 —— Enter 取 items[0],置顶会让「搜到的第一个匹配」变成已选项、一回车反而把它取消。
  const needle = q.trim().toLowerCase()
  const items = applyFilters(target.rows, refFilter, kindOfIn(target.columns), refFilterMode)
    .map((r) => ({ id: r.id, title: linkLabel(target, r, titleCol), on: sel.has(r.id) }))
    .filter((it) => !needle || it.title.toLowerCase().includes(needle))
    .sort((a, b) => (needle ? 0 : Number(b.on) - Number(a.on)))
    .slice(0, 12)
  return (
    <div className="amx-db-popwrap" onMouseDown={onClose}>
      <OverlayAt className="amx-db-pop" x={x} y={y} anchorTop={anchorTop} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="amx-db-pop-input"
          autoFocus
          placeholder={t('dbembed.searchRowsPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter' && items[0]) onPick(items[0].id)
          }}
        />
        <div className="amx-db-pop-list">
          {items.map((it) => (
            <button key={it.id} className="amx-db-opt" aria-pressed={multi ? it.on : undefined} onClick={() => onPick(it.id)}>
              {it.title}
              {it.on && <span className="amx-db-opt-check">✓</span>}
            </button>
          ))}
          {items.length === 0 && <div className="amx-db-blank">{t('dbembed.noMatchingRows')}</div>}
        </div>
        <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick(null)}>{t('dbembed.clearRelation')}</button>
      </OverlayAt>
    </div>
  )
}

/** 附件单元格:cell 存相对 .db 的路径(saveAsset 落它旁边的 .amadeus/)或 http(s) URL。
 *  图片扩展名给缩略图,其余给文件名按钮(系统默认程序打开);✕ 只清引用不删文件。 */
function FileCell({ row, col, env, setCell }: {
  row: DbRow
  col: DbColumn
  env: CellEnv
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
}) {
  const { t } = useI18n()
  // 多附件:cell 是 `string`(旧单值)或 `string[]`,读端两形态都认(纯逻辑 shared/db/fileCell.ts)。
  // 旧单值不迁移:只有用户再次编辑这一格才升格成数组。
  const refs = fileRefs(row.cells[col.id])
  const up = async (files: File[]): Promise<void> => {
    // ⚠️ 全部传完再写一次:逐个 setCell 会各自读到同一份陈旧 row.cells,最后只剩一个附件。
    const rels: string[] = []
    for (const f of files) rels.push(await amadeus.saveAsset(env.dbPath, f.name, new Uint8Array(await f.arrayBuffer())))
    setCell(row.id, col.id, addFileRefs(row.cells[col.id], rels))
  }
  const pick = (e: ReactChangeEvent<HTMLInputElement>): void => {
    const files = [...(e.target.files ?? [])]
    if (files.length) void up(files).catch((err: unknown) => window.alert(t('dbembed.uploadFail', { msg: err instanceof Error ? err.message : String(err) })))
    e.target.value = ''
  }
  const addBtn = (label: string): ReactNode => (
    <label className={label ? 'amx-db-cellbtn amx-db-fileadd' : 'amx-db-filemore'} title={label ? t('dbembed.uploadAttachment') : t('dbembed.appendAttachment')}>
      {label ? <><Paperclip size={13} /> {label}</> : '＋'}
      <input type="file" hidden multiple onChange={pick} />
    </label>
  )
  if (!refs.length) return addBtn(t('dbembed.type.file'))
  const openFile = (ref: string): void => {
    if (/^https?:\/\//i.test(ref)) window.open(ref, '_blank', 'noreferrer')
    else void amadeus.openAttachment(env.dbPath, ref)
  }
  return (
    <div className="amx-db-urlcell amx-db-files">
      {refs.map((ref, i) => {
        const base = ref.replace(/\\/g, '/').split('/').pop() || ref
        return (
          <span className="amx-db-file" key={`${ref}#${i}`}>
            {IMG_EXT_RE.test(ref.split('?')[0]) ? (
              <img className="amx-db-filethumb" src={fileSrc(env.dbPath, ref)} alt={base} title={base} onClick={() => openFile(ref)} loading="lazy" />
            ) : (
              <button className="amx-db-wikilink" onClick={() => openFile(ref)} title={ref}><Paperclip size={12} /> {base}</button>
            )}
            {/* 删到空写 undefined(删键),不是空数组:见 shared/db/fileCell.ts 的口径说明 */}
            <button className="amx-db-edit" onClick={() => setCell(row.id, col.id, removeFileAt(row.cells[col.id], i))} title={t('dbembed.removeAttachment')} aria-label="clear file">✕</button>
          </span>
        )
      })}
      {addBtn('')}
    </div>
  )
}

// ── 弹层(fixed;点外关闭) ────────────────────────────────────────────────────

function PopShell({ x, y, anchorTop, onClose, children }: { x: number; y: number; anchorTop?: number; onClose: () => void; children: ReactNode }) {
  // 关闭前先 blur 聚焦元素:React 同步卸载会赶在浏览器焦点转移前,被卸载的 input 不派发 blur,
  // ColMenu 重命名这类「onBlur 提交」的草稿会静默丢失——手动 blur 让 focusout 在卸载前发出。
  const close = (): void => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    onClose()
  }
  return (
    <div className="amx-db-popwrap" onMouseDown={close}>
      <OverlayAt className="amx-db-pop" x={x} y={y} anchorTop={anchorTop} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </OverlayAt>
    </div>
  )
}

/** select / multiselect 共用:共享 column.options 选项池,底部输入回车就地新增。 */
function OptionPopover({
  col,
  value,
  multi,
  onPick,
  onToggle,
  onCreate,
}: {
  col: DbColumn
  value: CellValue
  multi: boolean
  onPick: (label: string) => void
  onToggle: (label: string) => void
  onCreate: (label: string) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const opts = col.options ?? []
  const selected = multi ? (value as string[]) : []
  return (
    <>
      <div className="amx-db-pop-sec">{multi ? t('dbembed.optMulti') : t('dbembed.optSingle')}</div>
      <div className="amx-db-pop-list">
        {opts.map((o) =>
          multi ? (
            <label key={o} className="amx-db-opt">
              <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} />
              <span className={`amx-db-chip ${chipClass(o)}`}>{o}</span>
            </label>
          ) : (
            <button key={o} className="amx-db-opt" onClick={() => onPick(o)}>
              <span className={`amx-db-chip ${chipClass(o)}`}>{o}</span>
              {value === o && <span className="amx-db-opt-check">✓</span>}
            </button>
          ),
        )}
        {opts.length === 0 && <div className="amx-db-blank">{t('dbembed.optEmpty')}</div>}
        {!multi && typeof value === 'string' && value !== '' && (
          <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick('')}>{t('dbembed.clear')}</button>
        )}
      </div>
      <input
        className="amx-db-pop-input"
        autoFocus
        placeholder={t('dbembed.optNewPlaceholder')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            onCreate(draft.trim())
            setDraft('')
          }
        }}
      />
    </>
  )
}

function ColMenu({
  col,
  sort,
  onSort,
  onRename,
  onSetType,
  onDelete,
  locked,
  onMove,
  canMoveLeft,
  canMoveRight,
  columns,
  dbPath,
  dbFiles,
  targetColsOf,
  targetDbOf,
  onPatchCol,
}: {
  col: DbColumn
  sort: 'asc' | 'desc' | null
  onSort: (dir: 'asc' | 'desc' | null) => void
  onRename: (name: string) => void
  onSetType: (t: string) => void
  onDelete: () => void
  /** 首列(Name)身份列:锁定类型 + 禁删 + 位置固定。 */
  locked: boolean
  /** 列序左右挪一格(拖拽之外的入口:触屏拖不动,键盘也够得着)。 */
  onMove: (dir: -1 | 1) => void
  canMoveLeft: boolean
  canMoveRight: boolean
  /** 本表全列(lookup 选关联列用)。 */
  columns: DbColumn[]
  /** 本表路径(反向引用时标出目标表里「指回本表」的关联列)。 */
  dbPath: string
  /** 库里其他 .db(rowlink / 反向引用选目标表用;vault 相对路径)。 */
  dbFiles: string[]
  /** 目标表列清单(lookup 选目标列用;未加载完给空)。 */
  targetColsOf: (refDb: string) => DbColumn[]
  /** 目标库整份(rowlink 的芯片显示列 / 候选限定要目标表的列与行;未加载给 null)。 */
  targetDbOf: (refDb: string) => DbFile | null
  onPatchCol: (patch: Partial<DbColumn>) => void
}) {
  const { t } = useI18n()
  const relCols = columns.filter((c) => c.type === 'rowlink')
  // 引用列的正向/反向模式。isBackLookup 只认「配完了」的列(refDb+lookupBackCol 同在);半配置态(点了反向、
  // 还没选指回列)得靠本地 state 记住,初值:配完的反向列 / 有 refDb 没 lookupRel 的都算反向。
  const [back, setBack] = useState<boolean>(() => isBackLookup(col) || (!!col.refDb && !col.lookupRel))
  // 正向关联列**显式未选态**:不回落 relCols[0](回落只在菜单里装作选了、盘上没有 → 物化侧照样空;关联列被删/改类型后 lookupRel 被清,这里显示「待重新配置」)。
  const lookupRelCol = col.type === 'lookup' && !back ? relCols.find((c) => c.id === col.lookupRel) : undefined
  // 目标列不给嵌套 lookup(跨库链会引出环,物化侧也按 null 处理);公式列可选(读取时物化目标行)。
  const lookupTargetDb = back ? col.refDb : lookupRelCol?.refDb
  const lookupTargets = (lookupTargetDb ? targetColsOf(lookupTargetDb) : []).filter((c) => c.type !== 'lookup')
  // 反向:目标表里的关联表列(候选「指回本表」的列);refDb 指向本表的排前面并标出,别的也列(路径口径不一时不至于配不出来)。
  const norm = normDbPath
  const backCols = (back && col.refDb ? targetColsOf(col.refDb) : [])
    .filter((c) => c.type === 'rowlink')
    .sort((a, b) => Number(!!b.refDb && norm(b.refDb) === norm(dbPath)) - Number(!!a.refDb && norm(a.refDb) === norm(dbPath)))
  /** 切模式:清掉另一模式的字段 + lookupCol,否则一列同时带 lookupRel 与 refDb+lookupBackCol,两边各解一半。 */
  const switchMode = (toBack: boolean): void => {
    if (toBack === back) return
    setBack(toBack)
    if (toBack) onPatchCol({ lookupRel: undefined, lookupCol: undefined })
    else onPatchCol({ refDb: undefined, lookupBackCol: undefined, lookupCol: undefined, lookupKind: undefined }) // 投影是反向模式专属,一起清
  }
  const isProj = col.lookupKind === 'links'
  return (
    <>
      <input
        className="amx-db-pop-input"
        autoFocus
        defaultValue={col.name}
        onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== col.name) onRename(n) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <div className="amx-db-pop-sec">{t('dbembed.sortSec')}</div>
      <div className="amx-db-pop-list">
        <button className="amx-db-opt" onClick={() => onSort('asc')}>
          {t('dbembed.sortAsc')}{sort === 'asc' && <span className="amx-db-opt-check">✓</span>}
        </button>
        <button className="amx-db-opt" onClick={() => onSort('desc')}>
          {t('dbembed.sortDesc')}{sort === 'desc' && <span className="amx-db-opt-check">✓</span>}
        </button>
        {sort !== null && (
          <button className="amx-db-opt amx-db-opt-clear" onClick={() => onSort(null)}>{t('dbembed.clearSort')}</button>
        )}
      </div>
      {/* 列顺序(拖表头的等价入口:触屏拖不动、键盘也用得上;菜单不关,可以连点挪好几格) */}
      <div className="amx-db-pop-sec">{locked ? t('dbembed.colOrderFixed') : t('dbembed.colOrder')}</div>
      {!locked && (
        <div className="amx-db-pop-list amx-db-pop-row">
          <button className="amx-db-opt" disabled={!canMoveLeft} onClick={() => onMove(-1)}>{t('dbembed.moveLeft')}</button>
          <button className="amx-db-opt" disabled={!canMoveRight} onClick={() => onMove(1)}>{t('dbembed.moveRight')}</button>
        </div>
      )}
      {col.type === 'formula' && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.formulaSec')}</div>
          <textarea
            className="amx-db-pop-input amx-db-formula-in"
            rows={3}
            defaultValue={col.formula ?? ''}
            placeholder={t('dbembed.formulaPlaceholder')}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (col.formula ?? '')) onPatchCol({ formula: v || undefined }) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }}
          />
          <div className="amx-db-pop-sec">{t('dbembed.formulaHelp')}</div>
        </>
      )}
      {/* 数字显示格式:number 列 + 结果可能是数字的计算列。**只改显示**,落盘恒是原始数字。 */}
      {(col.type === 'number' || col.type === 'formula' || col.type === 'lookup') && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.numFmtSec')}</div>
          <div className="amx-db-pop-list amx-db-numfmt-cfg">
            <label>
              <span>{t('dbembed.precision')}</span>
              <input
                type="number"
                className="amx-db-pop-input"
                min={PRECISION_MIN}
                max={PRECISION_MAX}
                placeholder={t('dbembed.precisionPlaceholder')}
                defaultValue={col.precision ?? ''}
                aria-label="precision"
                onBlur={(e) => {
                  const raw = e.target.value.trim()
                  // 空 = 不设小数位(跟随原值);非法/越界一律夹回,别把坏值写进盘(zod 会整份拒读)
                  const next = raw === '' ? undefined : Math.min(PRECISION_MAX, Math.max(PRECISION_MIN, Math.trunc(Number(raw))))
                  const safe = next !== undefined && Number.isFinite(next) ? next : undefined
                  if (safe !== col.precision) onPatchCol({ precision: safe })
                  e.target.value = safe === undefined ? '' : String(safe)
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
            <label>
              <span>{t('dbembed.prefix')}</span>
              <input
                className="amx-db-pop-input"
                placeholder={t('dbembed.prefixPlaceholder')}
                defaultValue={col.unitPrefix ?? ''}
                aria-label="unit prefix"
                onBlur={(e) => { const v = e.target.value; if (v !== (col.unitPrefix ?? '')) onPatchCol({ unitPrefix: v || undefined }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
            <label>
              <span>{t('dbembed.suffix')}</span>
              <input
                className="amx-db-pop-input"
                placeholder={t('dbembed.suffixPlaceholder')}
                defaultValue={col.unitSuffix ?? ''}
                aria-label="unit suffix"
                onBlur={(e) => { const v = e.target.value; if (v !== (col.unitSuffix ?? '')) onPatchCol({ unitSuffix: v || undefined }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
          </div>
          <div className="amx-db-pop-sec">
            {hasNumberFormat(col) ? t('dbembed.numFmtSample', { sample: formatNumber(-1234.5, col) }) : t('dbembed.numFmtNone')}
          </div>
        </>
      )}
      {col.type === 'rowlink' && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.relTargetSec')}</div>
          <div className="amx-db-pop-list">
            {/* 「本表(自指)」置顶:dbFiles 刻意排掉了本表,没有这一项就**没有任何入口**能建出
                父任务/子任务那种自指关联列,视图菜单的「层级」也就永远无列可选(判据 rowLink.isSelfRefCol)。 */}
            <button className="amx-db-opt" data-selfref onClick={() => onPatchCol({ refDb: dbPath })}>
              {t('dbembed.relSelf')}
              {col.refDb && normDbPath(col.refDb) === normDbPath(dbPath) && <span className="amx-db-opt-check">✓</span>}
            </button>
            {dbFiles.map((f) => (
              <button key={f} className="amx-db-opt" onClick={() => onPatchCol({ refDb: f })}>
                {f.replace(/\.db$/i, '')}
                {col.refDb === f && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
            {dbFiles.length === 0 && <div className="amx-db-blank">{t('dbembed.noOtherDb')}</div>}
          </div>
          <div className="amx-db-pop-sec">{t('dbembed.multiSec')}</div>
          <div className="amx-db-pop-list">
            {/* 切回单选不动已有数组数据(只改后续编辑/筛选口径),避免破坏性塌值 */}
            <button className="amx-db-opt" role="switch" aria-checked={!!col.multiple} onClick={() => onPatchCol({ multiple: col.multiple ? undefined : true })}>
              {t('dbembed.allowMulti')}
              {col.multiple && <span className="amx-db-opt-check">✓</span>}
            </button>
          </div>
          {col.refDb && (() => {
            const tdb = targetDbOf(col.refDb)
            if (!tdb) return <div className="amx-db-blank">{t('dbembed.targetLoading')}</div>
            // 计算列磁盘无值:既不能当芯片文案,也不能当候选限定的条件列(picker 筛的是目标表磁盘行)
            const tcols = tdb.columns.filter((c) => !isComputed(c.type))
            const eff = titleColOf(tdb, col.titleCol)?.id
            return (
              <>
                <div className="amx-db-pop-sec">{t('dbembed.chipColSec')}</div>
                <div className="amx-db-pop-list" data-sec="titlecol">
                  {tcols.map((c) => (
                    <button key={c.id} className="amx-db-opt" onClick={() => onPatchCol({ titleCol: c.id })}>
                      <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
                      {c.name}
                      {eff === c.id && <span className="amx-db-opt-check">✓</span>}
                    </button>
                  ))}
                </div>
                <div className="amx-db-pop-sec">{t('dbembed.refFilterSec')}</div>
                <FilterRowsEditor
                  filters={col.refFilter ?? []}
                  mode={col.refFilterMode ?? 'and'}
                  columns={tcols}
                  kindOf={kindOfIn(tdb.columns)}
                  targetOf={(c) => { const d = c.type === 'rowlink' && c.refDb ? targetDbOf(c.refDb) : null; return d ? { path: c.refDb as string, db: d } : null }}
                  onChange={(f) => onPatchCol({ refFilter: f.length ? f : undefined })}
                  onMode={(mode) => onPatchCol({ refFilterMode: mode === 'or' ? 'or' : undefined })}
                />
              </>
            )
          })()}
        </>
      )}
      {col.type === 'lookup' && (
        <>
          {/* 双列行里标签得短,长句会折行、✓ 挤到中间(截图抓的) */}
          <div className="amx-db-pop-sec">{t('dbembed.lookupDirSec')}</div>
          <div className="amx-db-pop-list amx-db-pop-row">
            <button className="amx-db-opt" data-dim={back || undefined} onClick={() => switchMode(false)}>
              {t('dbembed.forward')}{!back && <span className="amx-db-opt-check">✓</span>}
            </button>
            <button className="amx-db-opt" data-dim={!back || undefined} onClick={() => switchMode(true)}>
              {t('dbembed.backward')}{back && <span className="amx-db-opt-check">✓</span>}
            </button>
          </div>
          {!back && (
            <>
              <div className="amx-db-pop-sec">{t('dbembed.lookupRelSec')}</div>
              {/* 有 lookupRel 却解析不到关联列 = 休眠/悬空(原关联列被改了类型或删了):就算本表已没有关联列也要说明白,别只剩「先建一个关联表列」 */}
              {!lookupRelCol && (relCols.length > 0 || col.lookupRel) && (
                <div className="amx-db-blank" data-pending>{col.lookupRel ? t('dbembed.lookupPendingStale') : t('dbembed.lookupPending')}</div>
              )}
              <div className="amx-db-pop-list">
                {relCols.map((c) => (
                  <button key={c.id} className="amx-db-opt" onClick={() => onPatchCol({ lookupRel: c.id })}>
                    {c.name}
                    {lookupRelCol?.id === c.id && <span className="amx-db-opt-check">✓</span>}
                  </button>
                ))}
                {relCols.length === 0 && <div className="amx-db-blank">{t('dbembed.needRelCol')}</div>}
              </div>
            </>
          )}
          {back && (
            <>
              <div className="amx-db-pop-sec">{t('dbembed.backTargetSec')}</div>
              <div className="amx-db-pop-list">
                {dbFiles.map((f) => (
                  <button key={f} className="amx-db-opt" onClick={() => onPatchCol({ refDb: f, lookupBackCol: undefined, lookupCol: undefined })}>
                    {f.replace(/\.db$/i, '')}
                    {col.refDb === f && <span className="amx-db-opt-check">✓</span>}
                  </button>
                ))}
                {dbFiles.length === 0 && <div className="amx-db-blank">{t('dbembed.noOtherDb')}</div>}
              </div>
              {col.refDb && (
                <>
                  <div className="amx-db-pop-sec">{t('dbembed.backColSec')}</div>
                  <div className="amx-db-pop-list">
                    {backCols.map((c) => {
                      // 不指回本表的关联列**禁用**(不是灰显可点):选了它 rollup 永远空,还会被 check:rowlink 报成悬空
                      const ok = !!c.refDb && norm(c.refDb) === norm(dbPath)
                      return (
                        <button key={c.id} className="amx-db-opt" disabled={!ok} title={ok ? undefined : t('dbembed.backColBad')} onClick={() => onPatchCol({ lookupBackCol: c.id })}>
                          {c.name}
                          {ok && <span className="amx-db-relpath">{t('dbembed.backHere')}</span>}
                          {col.lookupBackCol === c.id && <span className="amx-db-opt-check">✓</span>}
                        </button>
                      )
                    })}
                    {backCols.length === 0 && <div className="amx-db-blank">{t('dbembed.noBackCols')}</div>}
                  </div>
                  {col.lookupBackCol && (
                    <>
                      {/* 语义分工:投影列 = 关联本身(可编辑,真值只存目标表的关联列);普通引用 = 沿关联取值/聚合 */}
                      <div className="amx-db-pop-sec">{t('dbembed.projSec')}</div>
                      <div className="amx-db-pop-list" data-sec="projection">
                        <button className="amx-db-opt" role="switch" aria-checked={isProj} onClick={() => onPatchCol({ lookupKind: isProj ? undefined : 'links' })}>
                          {t('dbembed.projToggle')}
                          {isProj && <span className="amx-db-opt-check">✓</span>}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {(lookupRelCol || (back && col.refDb && col.lookupBackCol && !isProj)) && (
            <>
              <div className="amx-db-pop-sec">{t('dbembed.lookupColSec')}</div>
              <div className="amx-db-pop-list">
                {lookupTargets.map((c) => (
                  <button key={c.id} className="amx-db-opt" onClick={() => onPatchCol(back ? { lookupCol: c.id } : { lookupRel: lookupRelCol!.id, lookupCol: c.id })}>
                    {c.name}
                    {col.lookupCol === c.id && <span className="amx-db-opt-check">✓</span>}
                  </button>
                ))}
                {lookupTargets.length === 0 && <div className="amx-db-blank">{t('dbembed.targetNotReady')}</div>}
              </div>
              <div className="amx-db-pop-sec">{t('dbembed.aggSec')}</div>
              <div className="amx-db-pop-list amx-db-pop-row">
                {LOOKUP_AGGS.map((a) => (
                  <button key={a} className="amx-db-opt" data-dim={(col.lookupAgg ?? 'first') !== a || undefined} onClick={() => onPatchCol({ lookupAgg: a === 'first' ? undefined : a })}>
                    {t(LOOKUP_AGG_KEY[a])}
                    {(col.lookupAgg ?? 'first') === a && <span className="amx-db-opt-check">✓</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {locked ? (
        <div className="amx-db-pop-sec">{t('dbembed.identityLocked')}</div>
      ) : (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.typeSec')}</div>
          <div className="amx-db-pop-list">
            {/* 撤下 primitive date 与 todo:日期统一走富类型 calendarDate(标签「日期」),完成标记用普通 checkbox */}
            {[...COLUMN_TYPES, ...EXTRA_TYPES, ...allPropertyTypes().map((p) => p.type)].filter((ty) => ty !== 'date' && ty !== 'todo').map((ty) => (
              <button key={ty} className="amx-db-opt" onClick={() => onSetType(ty)}>
                <span className="amx-db-th-icon" aria-hidden>{colMeta(ty).icon}</span>
                {t(colMeta(ty).labelKey)}
                {col.type === ty && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
          </div>
          <button className="amx-db-opt amx-db-opt-danger" onClick={onDelete}>{t('dbembed.deleteCol')}</button>
        </>
      )}
    </>
  )
}

/** 笔记视图数据来源文件夹选择:列出全库子文件夹(+ 整库顶层)。切换即并集导入其笔记的属性。 */
function FolderPopover({ current, onPick }: { current: string; onPick: (f: string) => void }) {
  const { t } = useI18n()
  const [folders, setFolders] = useState<string[] | null>(null)
  useEffect(() => {
    void amadeus.listFolders().then((f) => setFolders(['', ...f]))
  }, [])
  return (
    <>
      <div className="amx-db-pop-sec">{t('dbembed.folderSec')}</div>
      <div className="amx-db-pop-list">
        {folders === null && <div className="amx-db-blank">{t('dbembed.loadingShort')}</div>}
        {folders?.map((f) => (
          <button key={f || '__root'} className="amx-db-opt" onClick={() => onPick(f)}>
            <span className="amx-db-th-icon" aria-hidden><FolderIcon /></span> {f || t('dbembed.vaultRoot')}
            {f === current && <span className="amx-db-opt-check">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}

// ── 多视图:选项弹层复用 / 视图菜单 / 行编辑器 / 卡片 / 看板 / 日历 / 画廊 ─────────────

/** select/multiselect 选项弹层连同取值/切换/新增语义:表格单元格与行编辑器两处共用。 */
function OptionsPop({ x, y, col, row, setCell, createOption, onClose }: {
  x: number
  y: number
  col: DbColumn
  row: DbRow
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  createOption: (colId: string, label: string) => void
  onClose: () => void
}) {
  const multi = col.type === 'multiselect'
  return (
    <PopShell x={x} y={y} onClose={onClose}>
      <OptionPopover
        col={col}
        value={coerceForDisplay(row.cells[col.id], resolveBaseType(col.type))}
        multi={multi}
        onPick={(label) => {
          setCell(row.id, col.id, label === '' ? undefined : label)
          onClose()
        }}
        onToggle={(label) => {
          const cur = coerceForDisplay(row.cells[col.id], 'multiselect') as string[]
          const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
          setCell(row.id, col.id, next.length ? next : undefined)
        }}
        onCreate={(label) => {
          createOption(col.id, label)
          if (multi) {
            const cur = coerceForDisplay(row.cells[col.id], 'multiselect') as string[]
            if (!cur.includes(label)) setCell(row.id, col.id, [...cur, label])
          } else {
            setCell(row.id, col.id, label)
            onClose()
          }
        }}
      />
    </PopShell>
  )
}

/** 视图 tab 菜单:改名 + 按类型的配置(看板/表格分组列/日历日期列)+ 列显隐 + 多列排序 + 删除。 */
function ViewMenu({ view, columns, sorts, chartGroupCol, treeCols, onCycleSort, onClearSorts, onRename, onPatch, onPickGroupBy, onPickDateCol, onToggleHidden, onToggleOwnCols, onOpenFilters, onOpenCalendar, calendarActive, onDelete }: {
  view: DbView
  columns: DbColumn[]
  sorts: Array<{ colId: string; dir: 'asc' | 'desc' }>
  /** chart:当前生效的分组列 id(含缺省自动挑的那个,解析单源 resolveChartGroupCol)。 */
  chartGroupCol?: string
  /** table 层级树可选的父列(自指关联列;判据单源 rowLink.treeColsOf)。 */
  treeCols?: DbColumn[]
  /** 点击列循环 升→降→移除(多列排序;新列追加末位)。 */
  onCycleSort: (colId: string) => void
  onClearSorts: () => void
  onRename: (name: string) => void
  onPatch: (patch: Partial<DbView>) => void
  onPickGroupBy: (colId: string) => void
  onPickDateCol: (colId: string) => void
  onToggleHidden: (colId: string) => void
  /** 「本视图独立列序/列宽」开关(开 = 拷全局序/宽进视图;关 = 清掉 order/widths)。 */
  onToggleOwnCols: () => void
  onOpenFilters: () => void
  onOpenCalendar: () => void
  calendarActive: boolean
  onDelete?: () => void
}) {
  const { t } = useI18n()
  const selectCols = columns.filter((c) => resolveBaseType(c.type) === 'select')
  const dateCols = columns.filter(isDateish)
  const numberCols = columns.filter((c) => resolveBaseType(c.type) === 'number')
  // 有效选中 = 视图记的列仍存在则用之,否则回落首个可用列(与视图体的解析一致)。
  const effective = (want: string | undefined, cands: DbColumn[]): string | undefined =>
    want && cands.some((c) => c.id === want) ? want : cands[0]?.id
  const pickList = (cands: DbColumn[], picked: string | undefined, onPick: (id: string) => void, empty: string, disabled?: boolean): ReactNode => (
    <div className="amx-db-pop-list">
      {cands.map((c) => (
        <button key={c.id} className="amx-db-opt" disabled={disabled} data-dim={disabled || undefined} onClick={() => onPick(c.id)}>
          <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
          {c.name}
          {picked === c.id && <span className="amx-db-opt-check">✓</span>}
        </button>
      ))}
      {cands.length === 0 && <div className="amx-db-blank">{empty}</div>}
    </div>
  )
  return (
    <>
      <input
        className="amx-db-pop-input"
        autoFocus
        defaultValue={view.name}
        onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== view.name) onRename(n) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      {view.type === 'kanban' && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.kanbanGroupSec')}</div>
          {pickList(selectCols, effective(view.groupBy, selectCols), onPickGroupBy, t('dbembed.noSelectCol'))}
        </>
      )}
      {!['kanban', 'calendar', 'gallery', 'chart', 'form', 'gantt'].includes(view.type) && (() => {
        const tCols = treeCols ?? []
        const groupCands = [...selectCols, ...dateCols]
        const groupIsDate = dateCols.some((c) => c.id === view.groupBy)
        // 树与分组互斥、树优先(渲染端同一条);这里只把分组区灰掉并写清理由,**不悄悄清掉 groupBy** ——
        // 关掉层级后用户原来的分组该原样回来。
        const treeOn = !!view.treeCol && tCols.some((c) => c.id === view.treeCol)
        return (
          <>
            <div className="amx-db-pop-sec">{t('dbembed.treeSec')}</div>
            {pickList(tCols, view.treeCol, (id) => onPatch({ treeCol: id }), t('dbembed.noTreeCol'))}
            {view.treeCol && (
              <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPatch({ treeCol: undefined })}>{t('dbembed.treeOff')}</button>
            )}
            <div className="amx-db-pop-sec">{treeOn ? t('dbembed.groupSecBlocked') : t('dbembed.groupSec')}</div>
            {pickList(groupCands, view.groupBy, onPickGroupBy, t('dbembed.noGroupCol'), treeOn)}
            {view.groupBy && !treeOn && (
              <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPatch({ groupBy: undefined })}>{t('dbembed.groupOff')}</button>
            )}
            {groupIsDate && !treeOn && (
              <>
                <div className="amx-db-pop-sec">{t('dbembed.groupUnitSec')}</div>
                <div className="amx-db-pop-list amx-db-pop-row">
                  {(['day', 'month'] as const).map((u) => (
                    <button key={u} className="amx-db-opt" data-groupunit={u} data-dim={dateGroupUnitOf(view.groupUnit) !== u || undefined}
                      onClick={() => onPatch({ groupUnit: u === 'day' ? undefined : u })}>
                      {u === 'day' ? t('dbembed.byDay') : t('dbembed.byMonth')}
                      {dateGroupUnitOf(view.groupUnit) === u && <span className="amx-db-opt-check">✓</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )
      })()}
      {view.type === 'calendar' && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.dateColSec')}</div>
          {pickList(dateCols, effective(view.dateCol, dateCols), onPickDateCol, t('dbembed.noDateCol'))}
        </>
      )}
      {view.type === 'gantt' && (() => {
        // 起止列只列 calendarDate;选中态与视图体同一解析(resolveGanttCols),别各解各的。嵌套配置每次写都要 spread,否则换档会把起止列冲掉。
        const gCols = ganttDateCols(columns)
        const cfg = view.gantt ?? {}
        const eff = resolveGanttCols(columns, view)
        const patchGantt = (p: Partial<DbViewGantt>): void => onPatch({ gantt: { ...cfg, ...p } })
        const scale = ganttScaleOf(cfg.scale)
        return (
          <>
            <div className="amx-db-pop-sec">{t('dbembed.ganttStartSec')}</div>
            {pickList(gCols, eff?.start.id, (id) => patchGantt({ startCol: id }), t('dbembed.noCalDateCol'))}
            <div className="amx-db-pop-sec">{t('dbembed.ganttEndSec')}</div>
            {pickList(gCols, eff?.end.id, (id) => patchGantt({ endCol: id }), t('dbembed.noCalDateCol'))}
            {cfg.endCol && <button className="amx-db-opt amx-db-opt-clear" onClick={() => patchGantt({ endCol: undefined })}>{t('dbembed.ganttEndSame')}</button>}
            <div className="amx-db-pop-sec">{t('dbembed.ganttScaleSec')}</div>
            <div className="amx-db-pop-list amx-db-pop-row">
              {(['day', 'week'] as const).map((s) => (
                <button key={s} className="amx-db-opt" data-dim={scale !== s || undefined} onClick={() => patchGantt({ scale: s })}>
                  {s === 'day' ? t('dbembed.scaleDay') : t('dbembed.scaleWeek')}
                  {scale === s && <span className="amx-db-opt-check">✓</span>}
                </button>
              ))}
            </div>
          </>
        )
      })()}
      {view.type === 'chart' && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.chartKindSec')}</div>
          <div className="amx-db-pop-list amx-db-pop-row">
            {CHART_KINDS.map((k) => (
              <button key={k} className="amx-db-opt" data-dim={chartKindOf(view.chartKind) !== k || undefined} onClick={() => onPatch({ chartKind: k })}>
                {t(CHART_KIND_KEY[k])}
                {chartKindOf(view.chartKind) === k && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
          </div>
          <div className="amx-db-pop-sec">{t('dbembed.chartGroupSec')}</div>
          {pickList(columns, chartGroupCol, (id) => onPatch({ groupBy: id }), t('dbembed.noColumn'))}
          <div className="amx-db-pop-sec">{t('dbembed.aggSec')}</div>
          <div className="amx-db-pop-list amx-db-pop-row">
            {CHART_AGGS.map((a) => (
              <button
                key={a}
                className="amx-db-opt"
                data-dim={chartAggOf(view.agg) !== a || undefined}
                disabled={a !== 'count' && !numberCols.length}
                title={a !== 'count' && !numberCols.length ? t('dbembed.needNumberCol') : undefined}
                onClick={() => onPatch(a === 'count' ? { agg: a } : { agg: a, valueCol: view.valueCol ?? numberCols[0]?.id })}
              >
                {t(CHART_AGG_KEY[a])}
                {chartAggOf(view.agg) === a && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
          </div>
          {chartAggOf(view.agg) !== 'count' && (
            <>
              <div className="amx-db-pop-sec">{t('dbembed.chartValueSec', { agg: t(CHART_AGG_KEY[chartAggOf(view.agg)]) })}</div>
              {pickList(numberCols, effective(view.valueCol, numberCols), (id) => onPatch({ valueCol: id }), t('dbembed.noNumberCol'))}
            </>
          )}
        </>
      )}
      {view.type === 'form' && (() => {
        const cfg = view.form ?? {}
        const patchForm = (p: Partial<DbViewForm>): void => onPatch({ form: { ...cfg, ...p } })
        const fields = formFields(columns, view)
        const required = cfg.required ?? []
        const after = cfg.after === 'table' ? 'table' : 'stay'
        return (
          <>
            <div className="amx-db-pop-sec">{t('dbembed.formTitleSec')}</div>
            <input className="amx-db-pop-input" placeholder={t('dbembed.formTitlePlaceholder', { name: view.name })} defaultValue={cfg.title ?? ''} data-form="title"
              onBlur={(e) => patchForm({ title: e.target.value.trim() || undefined })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            <input className="amx-db-pop-input" placeholder={t('dbembed.formSubmitPlaceholder')} defaultValue={cfg.submitText ?? ''} data-form="submit"
              onBlur={(e) => patchForm({ submitText: e.target.value.trim() || undefined })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            <div className="amx-db-pop-sec">{t('dbembed.formAfterSec')}</div>
            <div className="amx-db-pop-list amx-db-pop-row">
              {(['stay', 'table'] as const).map((a) => (
                <button key={a} className="amx-db-opt" data-dim={after !== a || undefined} onClick={() => patchForm({ after: a === 'stay' ? undefined : a })}>
                  {a === 'stay' ? t('dbembed.formStay') : t('dbembed.formGoTable')}
                  {after === a && <span className="amx-db-opt-check">✓</span>}
                </button>
              ))}
            </div>
            <div className="amx-db-pop-sec">{t('dbembed.formFieldsSec')}</div>
            <div className="amx-db-pop-list">
              {fields.map((c) => {
                const req = required.includes(c.id)
                return (
                  <div key={c.id} className="amx-db-formcfg" data-col={c.id}>
                    <button className="amx-db-opt" onClick={() => patchForm({ required: req ? required.filter((x) => x !== c.id) : [...required, c.id] })} data-dim={!req || undefined}>
                      <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
                      {c.name}
                      {req && <span className="amx-db-opt-check">{t('dbembed.required')}</span>}
                    </button>
                    <FormDefaultInput
                      col={c}
                      value={cfg.defaults?.[c.id]}
                      onChange={(v) => {
                        const d = { ...cfg.defaults }
                        if (v === undefined) delete d[c.id]
                        else d[c.id] = v
                        patchForm({ defaults: Object.keys(d).length ? d : undefined })
                      }}
                    />
                    <input className="amx-db-pop-input" placeholder={t('dbembed.descPlaceholder')} defaultValue={cfg.desc?.[c.id] ?? ''}
                      onBlur={(e) => {
                        const d = { ...cfg.desc }
                        const hint = e.target.value.trim()
                        if (hint) d[c.id] = hint
                        else delete d[c.id]
                        patchForm({ desc: Object.keys(d).length ? d : undefined })
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                  </div>
                )
              })}
              {fields.length === 0 && <div className="amx-db-blank">{t('dbembed.noFormFields')}</div>}
            </div>
          </>
        )
      })()}
      {(() => {
        // 开态 = 两字段任一存在(`{}` 是「开了没拖过」,不是空值;别按键数判)
        const own = view.order !== undefined || view.widths !== undefined
        return (
          <>
            <div className="amx-db-pop-sec">{t('dbembed.ownColsSec')}</div>
            <button className="amx-db-opt" data-owncols={own ? 'on' : 'off'} data-dim={!own || undefined} onClick={onToggleOwnCols}
              title={own ? t('dbembed.ownColsOn') : t('dbembed.ownColsOff')}>
              {t('dbembed.ownCols')}
              {own && <span className="amx-db-opt-check">✓</span>}
            </button>
          </>
        )
      })()}
      {columns.length > 1 && (
        <>
          <div className="amx-db-pop-sec">{t('dbembed.colVisSec')}</div>
          <div className="amx-db-pop-list">
            {columns.slice(1).map((c) => {
              const hidden = (view.hidden ?? []).includes(c.id)
              return (
                <button key={c.id} className="amx-db-opt" onClick={() => onToggleHidden(c.id)} data-dim={hidden || undefined}>
                  <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
                  {c.name}
                  {!hidden && <span className="amx-db-opt-check">✓</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
      <div className="amx-db-pop-sec">{t('dbembed.sortViewSec')}</div>
      <div className="amx-db-pop-list">
        {columns.map((c) => {
          const i = sorts.findIndex((s) => s.colId === c.id)
          const on = i >= 0
          return (
            <button key={c.id} className="amx-db-opt" data-dim={!on || undefined} onClick={() => onCycleSort(c.id)}>
              <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
              {c.name}
              {on && <span className="amx-db-opt-check">{sorts[i].dir === 'asc' ? '↑' : '↓'}{sorts.length > 1 ? ` ${i + 1}` : ''}</span>}
            </button>
          )
        })}
        {sorts.length > 0 && <button className="amx-db-opt amx-db-opt-clear" onClick={onClearSorts}>{t('dbembed.clearSort')}</button>}
      </div>
      <button className="amx-db-opt" onClick={onOpenFilters}>{t('dbembed.filterMore')}{(view.filters?.length ?? 0) > 0 && <span className="amx-db-opt-check">{view.filters!.length}</span>}</button>
      <button className="amx-db-opt" onClick={onOpenCalendar}>{calendarActive ? t('dbembed.calendarSettings') : t('dbembed.addToCalendar')}</button>
      {onDelete ? (
        <button className="amx-db-opt amx-db-opt-danger" onClick={onDelete}>{t('dbembed.deleteView')}</button>
      ) : (
        <div className="amx-db-pop-sec">{t('dbembed.lastViewLocked')}</div>
      )}
    </>
  )
}

/** 每视图筛选编辑:条件行编辑器 + 「筛选(本视图)」标题;列源 = 本表列。 */
function FiltersPop({ view, columns, kindOf, targetOf, onChange, onMode }: {
  view: DbView
  columns: DbColumn[]
  kindOf: (colId: string) => ColumnType | null
  targetOf: (col: DbColumn) => { path: string; db: DbFile } | null
  onChange: (filters: DbViewFilter[]) => void
  onMode: (mode: 'and' | 'or') => void
}) {
  const { t } = useI18n()
  return (
    <>
      <div className="amx-db-pop-sec">{t('dbembed.filterThisView')}</div>
      <FilterRowsEditor filters={view.filters ?? []} mode={view.filterMode === 'or' ? 'or' : 'and'} columns={columns} kindOf={kindOf} targetOf={targetOf} onChange={onChange} onMode={onMode} />
    </>
  )
}

/** 条件行编辑器:扁平条件列表(列 / op / 值)+ 且/或切换,原生 select 走天下。视图筛选(FiltersPop)与
 *  关联列「限定候选」(ColMenu,列源 = 目标表列)共用 —— 同一套算子、同一套值控件,别造第二份。 */
function FilterRowsEditor({ filters, mode, columns, kindOf, targetOf, onChange, onMode }: {
  filters: DbViewFilter[]
  mode: 'and' | 'or'
  /** 可选的条件列(FiltersPop = 本表全列;限定候选 = 目标表非计算列)。 */
  columns: DbColumn[]
  kindOf: (colId: string) => ColumnType | null
  /** 关联表列的目标库(值控件列目标行标题,值 = 行 id;没有它 select/multiselect 会渲成空下拉)。 */
  targetOf: (col: DbColumn) => { path: string; db: DbFile } | null
  onChange: (filters: DbViewFilter[]) => void
  onMode: (mode: 'and' | 'or') => void
}) {
  const { t } = useI18n()
  const patch = (i: number, p: Partial<DbViewFilter>): void =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...p } : f)))
  const opsFor = (colId: string): string[] => FILTER_OPS[kindOf(colId) ?? 'text']
  return (
    <>
      {filters.length >= 2 && (
        <div className="amx-db-pop-list amx-db-pop-row">
          <button className="amx-db-opt" data-dim={mode !== 'and' || undefined} onClick={() => onMode('and')}>
            {t('dbembed.filterAll')}{mode === 'and' && <span className="amx-db-opt-check">✓</span>}
          </button>
          <button className="amx-db-opt" data-dim={mode !== 'or' || undefined} onClick={() => onMode('or')}>
            {t('dbembed.filterAny')}{mode === 'or' && <span className="amx-db-opt-check">✓</span>}
          </button>
        </div>
      )}
      {filters.map((f, i) => {
        const kind = kindOf(f.colId) ?? 'text'
        const col = columns.find((c) => c.id === f.colId)
        const unary = UNARY_OPS.has(f.op)
        return (
          <div key={i} className="amx-db-fltrow">
            <select
              className="amx-db-fltsel"
              value={f.colId}
              onChange={(e) => {
                const colId = e.target.value
                onChange(filters.map((x, j) => (j === i ? { colId, op: opsFor(colId)[0], value: undefined } : x)))
              }}
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              {!col && <option value={f.colId}>({f.colId})</option>}
            </select>
            <select className="amx-db-fltsel" value={f.op} onChange={(e) => patch(i, { op: e.target.value, ...(UNARY_OPS.has(e.target.value) ? { value: undefined } : null) })}>
              {opsFor(f.colId).map((op) => (
                <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>
              ))}
              {!opsFor(f.colId).includes(f.op) && <option value={f.op}>{OP_LABEL[f.op] ?? f.op}</option>}
            </select>
            {/* 关联表列先于 select/multiselect 判:它没有 options,值是目标行 id、显示目标行标题 */}
            {!unary && col?.type === 'rowlink' && (() => {
              const tgt = targetOf(col)
              const cur = String(f.value ?? '')
              return (
                <select className="amx-db-fltsel" value={cur} onChange={(e) => patch(i, { value: e.target.value || undefined })}>
                  <option value="">…</option>
                  {(tgt?.db.rows ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{linkLabel(tgt!.db, r, col.titleCol)}</option>
                  ))}
                  {cur && !tgt?.db.rows.some((r) => r.id === cur) && <option value={cur}>({cur})</option>}
                </select>
              )
            })()}
            {!unary && col?.type !== 'rowlink' && kind === 'select' && (
              <select className="amx-db-fltsel" value={String(f.value ?? '')} onChange={(e) => patch(i, { value: e.target.value })}>
                <option value="">…</option>
                {(col?.options ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}
            {!unary && col?.type !== 'rowlink' && kind === 'multiselect' && (
              <select className="amx-db-fltsel" value={String(f.value ?? '')} onChange={(e) => patch(i, { value: e.target.value })}>
                <option value="">…</option>
                {(col?.options ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}
            {!unary && kind === 'date' && (
              <input className="amx-db-fltin" type="date" value={String(f.value ?? '')} onChange={(e) => patch(i, { value: e.target.value || undefined })} />
            )}
            {!unary && kind === 'number' && (
              <input className="amx-db-fltin" type="number" value={f.value == null ? '' : String(f.value)} onChange={(e) => patch(i, { value: e.target.value === '' ? undefined : Number(e.target.value) })} />
            )}
            {!unary && kind !== 'select' && kind !== 'multiselect' && kind !== 'date' && kind !== 'number' && (
              <input className="amx-db-fltin" value={String(f.value ?? '')} placeholder={t('dbembed.valuePlaceholder')} onChange={(e) => patch(i, { value: e.target.value || undefined })} />
            )}
            <button className="amx-db-fltdel" onClick={() => onChange(filters.filter((_, j) => j !== i))} title={t('dbembed.removeCondition')} aria-label="remove filter">✕</button>
          </div>
        )
      })}
      {filters.length === 0 && <div className="amx-db-blank">{t('dbembed.noConditions')}</div>}
      <button
        className="amx-db-opt"
        onClick={() => {
          const c = columns[0]
          if (c) onChange([...filters, { colId: c.id, op: opsFor(c.id)[0] }])
        }}
      >
        {t('dbembed.addCondition')}
      </button>
      {filters.length > 0 && (
        <button className="amx-db-opt amx-db-opt-clear" onClick={() => onChange([])}>{t('dbembed.clearAll')}</button>
      )}
    </>
  )
}

/** 行详情编辑:全列纵排,复用表格同款 Cell(看板/日历/画廊点卡即编辑);select 选项开嵌套弹层。 */
function RowEditor({ db, row, pagePath, env, setCell, createOption, onDelete }: {
  db: DbFile
  row: DbRow
  pagePath: string
  env: CellEnv
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  createOption: (colId: string, label: string) => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const [opt, setOpt] = useState<{ colId: string; x: number; y: number } | null>(null)
  const optCol = opt ? db.columns.find((c) => c.id === opt.colId) : undefined
  return (
    <div className="amx-db-roweditor">
      {db.columns.map((col) => (
        <div key={col.id} className="amx-db-rowed-field" data-coltype={resolveBaseType(col.type)}>
          <span className="amx-db-rowed-label">
            <span className="amx-db-th-icon" aria-hidden>{colMeta(col.type).icon}</span>
            {col.name}
          </span>
          <div className="amx-db-rowed-cell">
            <Cell
              row={row}
              col={col}
              pagePath={pagePath}
              env={env}
              setCell={setCell}
              openOptions={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setOpt({ colId: col.id, x: Math.min(r.left, window.innerWidth - 250), y: Math.min(r.bottom + 4, window.innerHeight - 260) })
              }}
            />
          </div>
        </div>
      ))}
      <button className="amx-db-opt amx-db-opt-danger" onClick={onDelete}>{t('dbembed.deleteRow')}</button>
      {opt && optCol && (
        <OptionsPop x={opt.x} y={opt.y} col={optCol} row={row} setCell={setCell} createOption={createOption} onClose={() => setOpt(null)} />
      )}
    </div>
  )
}

/** 卡片上的只读属性预览:空值不占行;select/多选 → chips,勾选 → 只在为真时点名列名,
 *  calendarDate → 人类可读,其余 → 文本。 */
function cellPreview(col: DbColumn, v: CellValue | undefined): ReactNode | null {
  // ponytail: rowlink 存的是行 id、file 存的是路径,裸串上卡片只添乱 —— 预览先跳过,标题化再说。
  if (col.type === 'rowlink' || col.type === 'file') return null
  const base = resolveBaseType(col.type)
  const d = coerceForDisplay(v, base)
  if (base === 'checkbox') return d === true ? <span className="amx-db-card-check">✓ {col.name}</span> : null
  if (base === 'select') return d ? <span className={`amx-db-chip ${chipClass(d as string)}`}>{d as string}</span> : null
  if (base === 'multiselect') {
    const arr = d as string[]
    return arr.length ? <>{arr.map((t) => <span key={t} className={`amx-db-chip ${chipClass(t)}`}>{t}</span>)}</> : null
  }
  let s = Array.isArray(d) ? d.join(', ') : d == null ? '' : String(d)
  if (col.type === 'calendarDate') s = fmtCalDateL(parseCalDate(s)) || s
  return s ? <span className="amx-db-card-text">{s}</span> : null
}

/** 看板/画廊共用卡片:可选封面 + 标题 + 前几个非空属性预览。 */
function RowCard({ db, row, title, onClick, cols, skipColId, max = 3, draggable, onDragStart, cover }: {
  db: DbFile
  row: DbRow
  title: string
  onClick: (e: ReactMouseEvent) => void
  /** 预览用的列集(视图可见列);缺 = 全列。首列(标题)恒跳过。 */
  cols?: DbColumn[]
  /** 不预览的列(看板分组列,泳道本身已表达)。 */
  skipColId?: string
  max?: number
  draggable?: boolean
  onDragStart?: (e: ReactDragEvent) => void
  /** 卡片封面(画廊:首个附件列的图片)。 */
  cover?: ReactNode
}) {
  const previews: ReactNode[] = []
  for (const col of (cols ?? db.columns).slice(1)) {
    if (previews.length >= max) break
    if (col.id === skipColId) continue
    const node = cellPreview(col, row.cells[col.id])
    if (node) previews.push(<div className="amx-db-card-prop" key={col.id}>{node}</div>)
  }
  return (
    <div className="amx-db-card" role="button" tabIndex={0} draggable={draggable} onDragStart={onDragStart} onClick={onClick}>
      {cover}
      <div className="amx-db-card-title">{title}</div>
      {previews}
    </div>
  )
}

/** 看板:按单选列分组为泳道(选项序 + 未分组),HTML5 拖卡跨道改组值;组内顺序 = 行序。 */
function KanbanBody({ db, rows, view, visCols, setCell, addRow, openRow, rowTitle, addStatusCol }: {
  db: DbFile
  rows: DbRow[]
  view: DbView
  visCols: DbColumn[]
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  addRow: (initial?: Record<string, CellValue>) => void
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
  addStatusCol: () => void
}) {
  const { t } = useI18n()
  const groupCol =
    db.columns.find((c) => c.id === view.groupBy && resolveBaseType(c.type) === 'select') ??
    db.columns.find((c) => resolveBaseType(c.type) === 'select')
  if (!groupCol) {
    return (
      <div className="amx-db-state">
        {t('dbembed.kanbanNeedSelect')}
        <button className="amx-db-linkbtn" onClick={addStatusCol}>{t('dbembed.addStatusCol')}</button>
      </div>
    )
  }
  const opts = groupCol.options ?? []
  const lanes: Array<string | null> = [...opts, null] // null = 未分组(含选项已被删的孤值)
  const laneRows = (opt: string | null): DbRow[] =>
    rows.filter((r) => {
      const v = coerceForDisplay(r.cells[groupCol.id], 'select') as string
      return opt === null ? !v || !opts.includes(v) : v === opt
    })
  const onDrop = (opt: string | null) => (e: ReactDragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id) setCell(id, groupCol.id, opt ?? undefined)
  }
  return (
    <div className="amx-db-kanban">
      {lanes.map((opt) => {
        const cards = laneRows(opt)
        return (
          <div key={opt ?? '__none'} className="amx-db-lane" onDragOver={(e) => e.preventDefault()} onDrop={onDrop(opt)}>
            <div className="amx-db-lane-head">
              {opt ? <span className={`amx-db-chip ${chipClass(opt)}`}>{opt}</span> : <span className="amx-db-lane-none">{t('dbembed.laneNone')}</span>}
              <span className="amx-db-lane-count">{cards.length}</span>
            </div>
            <div className="amx-db-lane-cards">
              {cards.map((r) => (
                <RowCard
                  key={r.id}
                  db={db}
                  row={r}
                  title={rowTitle(r)}
                  cols={visCols}
                  skipColId={groupCol.id}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move' }}
                  onClick={(e) => openRow(e, r.id)}
                />
              ))}
            </div>
            <button className="amx-db-lane-add" onClick={() => addRow(opt ? { [groupCol.id]: opt } : undefined)}>
              <PlusIcon /> {t('dbembed.newCard')}
            </button>
          </div>
        )
      })}
    </div>
  )
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const fmtYmd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 日历:按日期列(date / calendarDate)铺月栅格,周日起始(与 Calendar Space 一致);
 *  区间值逐日铺条;日格 ＋ 新行带当日初值。42 格恒定,月份切换高度不跳。 */
function CalendarBody({ db, rows, view, addRow, openRow, rowTitle, addDateCol }: {
  db: DbFile
  rows: DbRow[]
  view: DbView
  addRow: (initial?: Record<string, CellValue>) => void
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
  addDateCol: () => void
}) {
  const { t } = useI18n()
  const [ym, setYm] = useState(() => {
    const n = new Date()
    return { y: n.getFullYear(), m: n.getMonth() }
  })
  const dateCol = db.columns.find((c) => c.id === view.dateCol && isDateish(c)) ?? firstDateish(db.columns)
  if (!dateCol) {
    return (
      <div className="amx-db-state">
        {t('dbembed.calendarNeedDate')}
        <button className="amx-db-linkbtn" onClick={addDateCol}>{t('dbembed.addDateCol')}</button>
      </div>
    )
  }
  // 单日与区间统一走 parseCalDate('YYYY-MM-DD' 本身就是合法单日)。
  const spanOf = (r: DbRow): { s: string; e: string } | null => {
    const raw = r.cells[dateCol.id]
    const c = typeof raw === 'string' ? parseCalDate(raw) : null
    if (!c) return null
    const s = splitSide(c.start).date
    const e = c.end ? splitSide(c.end).date : s
    return { s, e: e >= s ? e : s }
  }
  const lead = new Date(ym.y, ym.m, 1).getDay()
  const cells = Array.from({ length: 42 }, (_, i) => new Date(ym.y, ym.m, 1 - lead + i))
  const byDay = new Map<string, DbRow[]>()
  for (const r of rows) {
    const sp = spanOf(r)
    if (!sp) continue
    for (const d of cells) {
      const k = fmtYmd(d)
      if (k >= sp.s && k <= sp.e) {
        const arr = byDay.get(k)
        if (arr) arr.push(r)
        else byDay.set(k, [r])
      }
    }
  }
  const todayK = fmtYmd(new Date())
  return (
    <div className="amx-db-cal">
      <div className="amx-db-cal-nav">
        <button className="amx-db-cal-btn" onClick={() => setYm(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))} aria-label="prev month">‹</button>
        <span className="amx-db-cal-title">{t('dbembed.calMonth', { y: ym.y, m: ym.m + 1 })}</span>
        <button className="amx-db-cal-btn" onClick={() => setYm(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))} aria-label="next month">›</button>
        <button className="amx-db-linkbtn" onClick={() => { const n = new Date(); setYm({ y: n.getFullYear(), m: n.getMonth() }) }}>{t('dbembed.today')}</button>
        <span className="amx-db-cal-colhint" title={t('dbembed.calDateColHint')}>
          <span className="amx-db-th-icon" aria-hidden>{colMeta(dateCol.type).icon}</span>
          {dateCol.name}
        </span>
      </div>
      <div className="amx-db-cal-grid">
        {['dbembed.dow0', 'dbembed.dow1', 'dbembed.dow2', 'dbembed.dow3', 'dbembed.dow4', 'dbembed.dow5', 'dbembed.dow6'].map((k) => (
          <div className="amx-db-cal-dow" key={k}>{t(k)}</div>
        ))}
        {cells.map((d) => {
          const k = fmtYmd(d)
          const dayRows = byDay.get(k) ?? []
          const inMonth = d.getMonth() === ym.m
          return (
            <div className={`amx-db-cal-day${inMonth ? '' : ' amx-db-cal-out'}${k === todayK ? ' amx-db-cal-today' : ''}`} key={k}>
              <div className="amx-db-cal-dayhead">
                <span className="amx-db-cal-num">{d.getDate()}</span>
                <button className="amx-db-cal-add" onClick={() => addRow({ [dateCol.id]: k })} title={t('dbembed.addOnDay')} aria-label={`add row on ${k}`}>
                  <PlusIcon />
                </button>
              </div>
              {dayRows.map((r) => (
                <button className="amx-db-ev" key={r.id} onClick={(e) => openRow(e, r.id)} title={rowTitle(r)}>{rowTitle(r)}</button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 画廊:卡片栅格,点卡开行编辑;首个附件列的图片作封面。 */
function GalleryBody({ db, rows, visCols, addRow, openRow, rowTitle, coverOf }: {
  db: DbFile
  rows: DbRow[]
  visCols: DbColumn[]
  addRow: (initial?: Record<string, CellValue>) => void
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
  coverOf: (r: DbRow) => ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="amx-db-gallery">
      {rows.map((r) => (
        <RowCard key={r.id} db={db} row={r} title={rowTitle(r)} cols={visCols} max={4} cover={coverOf(r)} onClick={(e) => openRow(e, r.id)} />
      ))}
      <button className="amx-db-card amx-db-card-add" onClick={() => addRow()}>
        <PlusIcon /> {t('dbembed.newCard')}
      </button>
    </div>
  )
}
