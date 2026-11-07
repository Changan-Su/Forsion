// 改动记录台架(scripts/change-trail.e2e.cjs)与方案图共用的演示会话(只在台架 / 方案图里;产品里不内置任何示例)。
// 原件:仓根 docs/ToBeImproved/文件改动记录方案_2026-11-06/instrument/fixtures.cjs。
// 场景:一条会话两轮。第 1 轮把报表页默认范围改成 30 天(1 处);第 2 轮加「导出 CSV」:
// 新建 1 个文件、同一个文件改 2 次、改 1 个文案表、改用户手册里一段说明(文本工作者那半),再跑一次测试。
// 文件「改前」全文写在这里,改后 = 按工具参数原样替换 —— 方案图里的行号、增减都是真算出来的,不是手填。
const SID = 'diff-trail'
// 台架里给一个工作目录:回执里的文件夹按它缩短成相对路径(方案图那份是 projectless)
const PROJECT = '/Users/demo/report-app'
const SESSION = { id: SID, title: '报表页加导出 CSV', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: false, project_path: PROJECT, created_at: '2026-11-06 09:00:00', updated_at: '2026-11-06 09:24:00' }
const T = 1793840400000
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, ui_content_offset: 0 })
const res = (id, name, content) => ({ tool_call_id: id, name, content, isError: false })

const REPORT_V0 = `import React, { useState } from 'react'
import { Button, Card, RangePicker, Table } from '../ui'
import { useReport } from '../data/useReport'
import { useI18n } from '../i18n'
import type { Range } from '../data/types'

/** 报表页:按日期范围汇总订单与退款。 */
export function ReportView() {
  const { t } = useI18n()
  const [range, setRange] = useState<Range>('7d')
  const { rows, loading } = useReport(range)

  return (
    <Card title={t('report.title')}>
      <div className="report-toolbar">
        <RangePicker value={range} onChange={setRange} />
      </div>
      <Table
        loading={loading}
        rows={rows}
        columns={[
          { key: 'date', title: t('report.date') },
          { key: 'orders', title: t('report.orders'), align: 'right' },
          { key: 'refunds', title: t('report.refunds'), align: 'right' },
          { key: 'revenue', title: t('report.revenue'), align: 'right' },
        ]}
      />
    </Card>
  )
}
`
const MESSAGES_V0 = `// 报表页文案(zh / en 成对)
export const reportMessages = {
  'report.title': { zh: '报表', en: 'Report' },
  'report.date': { zh: '日期', en: 'Date' },
  'report.orders': { zh: '订单', en: 'Orders' },
  'report.refunds': { zh: '退款', en: 'Refunds' },
  'report.revenue': { zh: '收入', en: 'Revenue' },
  'report.empty': { zh: '这段时间没有数据', en: 'No data in this range' },
}
`
const MANUAL_V0 = `# 用户手册

## 查看报表

左侧栏点「报表」进入报表页。右上角可以切换日期范围:最近 7 天、30 天或自定义。

表格按天汇总订单、退款与收入,点表头可以排序。

## 导出数据

目前报表只能截图保存。需要原始数据时,请联系管理员从后台导出。

导出前请确认日期范围,后台一次最多导出 90 天。

## 常见问题

**数字和后台对不上?** 报表按下单日期统计,后台按付款日期,跨天的订单会落在不同的日子里。
`
const TOCSV = `/** 表格行 → CSV 文本(RFC 4180:含逗号、引号、换行的格子加引号,引号写两遍)。 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  const cell = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s
  }
  const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))]
  // 加 BOM:Excel 双击打开中文不乱码
  return '\\ufeff' + lines.join('\\r\\n')
}

/** 把文本存成文件(浏览器下载)。 */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
`

// —— 两轮里的编辑(工具参数原样;old_string 必须在当时的文件里唯一出现) ——
const E0 = { path: 'src/views/ReportView.tsx', old_string: "  const [range, setRange] = useState<Range>('7d')\n", new_string: "  const [range, setRange] = useState<Range>('30d')\n" }
const E1 = { path: 'src/views/ReportView.tsx', old_string: "import { useReport } from '../data/useReport'\n", new_string: "import { useReport } from '../data/useReport'\nimport { downloadText, toCsv } from '../export/toCsv'\n" }
const E2 = { path: 'src/views/ReportView.tsx', old_string: '        <RangePicker value={range} onChange={setRange} />\n', new_string: "        <RangePicker value={range} onChange={setRange} />\n        <Button icon=\"download\" onClick={() => downloadText(`report-${range}.csv`, toCsv(rows))}>\n          {t('report.exportCsv')}\n        </Button>\n" }
const E3 = { path: 'src/i18n/report.ts', old_string: "  'report.empty': { zh: '这段时间没有数据', en: 'No data in this range' },\n", new_string: "  'report.empty': { zh: '这段时间没有数据', en: 'No data in this range' },\n  'report.exportCsv': { zh: '导出 CSV', en: 'Export CSV' },\n" }
const E4 = { path: 'docs/用户手册.md', old_string: '目前报表只能截图保存。需要原始数据时,请联系管理员从后台导出。\n\n导出前请确认日期范围,后台一次最多导出 90 天。\n', new_string: '报表页右上角的「导出 CSV」会把当前日期范围内的数据存成表格文件,可以直接用 Excel 或 Numbers 打开。\n\n导出前请确认日期范围,一次最多导出 90 天。\n' }
const W1 = { path: 'src/export/toCsv.ts', content: TOCSV }

const rep = (s, e) => { if (s.split(e.old_string).length !== 2) throw new Error('old_string 不唯一: ' + e.path); return s.replace(e.old_string, e.new_string) }
// 每个文件:本会话开始前 / 第 1 轮后 / 第 2 轮后(= 现在)
const REPORT_V1 = rep(REPORT_V0, E0)
const FILES = {
  'src/views/ReportView.tsx': { v0: REPORT_V0, v1: REPORT_V1, v2: rep(rep(REPORT_V1, E1), E2) },
  'src/export/toCsv.ts': { v0: null, v1: null, v2: TOCSV },
  'src/i18n/report.ts': { v0: MESSAGES_V0, v1: MESSAGES_V0, v2: rep(MESSAGES_V0, E3) },
  'docs/用户手册.md': { v0: MANUAL_V0, v1: MANUAL_V0, v2: rep(MANUAL_V0, E4) },
}

const messages = [
  { id: 'u0', role: 'user', timestamp: T, content: '报表页默认显示最近 30 天吧,7 天太短了。' },
  { id: 'a0', role: 'model', timestamp: T + 20000,
    tool_calls: [call('p1', 'edit_file', E0)],
    tool_results: [res('p1', 'edit_file', 'Edited src/views/ReportView.tsx')],
    content: '改好了,报表页打开时默认是最近 30 天,切换范围的选项没动。' },
  { id: 'u1', role: 'user', timestamp: T + 600000, content: '再加一个导出 CSV 的按钮。用户手册里「导出数据」那节也顺手更新一下。' },
  { id: 'a1', role: 'model', timestamp: T + 610000,
    reasoning: '先看报表页现在的工具栏怎么摆,按钮放在日期范围旁边。CSV 单独写成一个小函数,方便测。手册里那段还写着「只能截图」,要改成新做法。',
    tool_calls: [
      call('t1', 'read_file', { path: 'src/views/ReportView.tsx' }),
      call('t2', 'write_file', W1),
      call('t3', 'edit_file', E1),
      call('t4', 'edit_file', E2),
      call('t5', 'edit_file', E3),
      call('t6', 'edit_file', E4),
      call('t7', 'run_bash', { command: 'npm test -- toCsv' }),
    ],
    tool_results: [
      res('t1', 'read_file', REPORT_V1),
      res('t2', 'write_file', 'Wrote src/export/toCsv.ts'),
      res('t3', 'edit_file', 'Edited src/views/ReportView.tsx'),
      res('t4', 'edit_file', 'Edited src/views/ReportView.tsx'),
      res('t5', 'edit_file', 'Edited src/i18n/report.ts'),
      res('t6', 'edit_file', 'Edited docs/用户手册.md'),
      res('t7', 'run_bash', ' ✓ src/export/toCsv.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)'),
    ],
    content: '加好了。报表页右上角多了「导出 CSV」,导出的是当前日期范围里的数据;含逗号、引号的格子会加引号,文件带 BOM,Excel 双击打开中文不乱码。\n\n用户手册「导出数据」那节改成了新做法,原来「只能截图」那句删了。\n\n`toCsv` 的两条测试都过了。' },
]

module.exports = { SID, SESSION, PROJECT, T, messages, FILES }
