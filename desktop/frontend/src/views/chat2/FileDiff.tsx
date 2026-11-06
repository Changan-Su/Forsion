/**
 * 一个文件的改动(引擎给的统一 diff 正文:真行号、上下文 2 行、不带文件头)→ 两列行号 + 记号 + 正文的表。
 * 颜色跟主题的 --green / --danger 走(浅底,不用 diff2html 自带的亮绿亮黄);一删一加成对时只标改掉的那几个字 / 词,
 * 一行里相同的不到一半就整行标(整句改写别碎成一个个字)。文字类文件换行、用正文字体。
 */
import { memo, useMemo } from 'react'
import { diffChars, diffWordsWithSpace } from 'diff'
import { useI18n, registerMessages } from '../../i18n'
import './changeTrail.css'

registerMessages({
  'changes.diff.line': { zh: '⋯ 第 {n} 行', en: '⋯ Line {n}' },
  'changes.diff.more': { zh: '⋯ 还有 {n} 行没显示', en: '⋯ {n} more lines not shown' },
  'changes.diff.truncated': { zh: '⋯ 后面太长，没显示', en: '⋯ The rest is too long to show' },
})

type Row =
  | { k: 'hunk'; line: number }
  | { k: 'ctx' | 'add' | 'del'; o?: number; n?: number; text: string; marks?: Seg[] }
  | { k: 'more'; count: number }
interface Seg { text: string; on: boolean }

/** 引擎的 diff 正文 → 行。导出给单测。 */
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0, n = 0
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) { o = Number(h[1]); n = Number(h[2]); rows.push({ k: 'hunk', line: Math.max(1, n) }); continue }
    const c = line[0]
    if (c === ' ') rows.push({ k: 'ctx', o: o++, n: n++, text: line.slice(1) })
    else if (c === '-') rows.push({ k: 'del', o: o++, text: line.slice(1) })
    else if (c === '+') rows.push({ k: 'add', n: n++, text: line.slice(1) })
    // 「\ No newline at end of file」之类:不画
  }
  return rows
}

/** 一删一加成对的行:只标改掉的部分;相同的不到一半就整行(不给 marks)。导出给单测。 */
export function markPairs(rows: Row[], prose: boolean): Row[] {
  const out = rows.slice()
  for (let i = 0; i < out.length;) {
    if (out[i].k !== 'del') { i++; continue }
    let j = i
    while (j < out.length && out[j].k === 'del') j++
    let e = j
    while (e < out.length && out[e].k === 'add') e++
    const dels = j - i, adds = e - j
    for (let x = 0; x < Math.min(dels, adds); x++) {
      const d = out[i + x] as Extract<Row, { text: string }>, a = out[j + x] as Extract<Row, { text: string }>
      if (d.text.length + a.text.length > 4000) continue
      const parts = prose ? diffChars(d.text, a.text) : diffWordsWithSpace(d.text, a.text)
      const same = parts.filter((p) => !p.added && !p.removed).reduce((s, p) => s + p.value.length, 0)
      if (same / Math.max(d.text.length, a.text.length, 1) < 0.5) continue
      out[i + x] = { ...d, marks: parts.filter((p) => !p.added).map((p) => ({ text: p.value, on: !!p.removed })) }
      out[j + x] = { ...a, marks: parts.filter((p) => !p.removed).map((p) => ({ text: p.value, on: !!p.added })) }
    }
    i = e
  }
  return out
}

/** 新建的文件只露头几行,其余收成「还有 N 行」(点文件名去 Desk 看全文)。 */
function capCreated(rows: Row[], head: number): Row[] {
  const body = rows.filter((r) => r.k !== 'hunk')
  if (!body.every((r) => r.k === 'add') || body.length <= head + 2) return rows
  return [...body.slice(0, head), { k: 'more', count: body.length - head }]
}

export const FileDiff = memo(function FileDiff({ patch, prose, truncated, createdHead }: {
  patch: string
  prose: boolean
  truncated?: boolean
  /** 新建文件只露前几行;不给 = 全露。 */
  createdHead?: number
}) {
  const { t } = useI18n()
  const rows = useMemo(() => {
    const r = markPairs(parsePatch(patch), prose)
    return createdHead ? capCreated(r, createdHead) : r
  }, [patch, prose, createdHead])
  // 开头那个 hunk 从第 1 行起时不画「第 1 行」;后面的分隔照画
  const firstHunk = rows.findIndex((r) => r.k === 'hunk')
  return (
    <div className={`ct-diff${prose ? ' prose' : ''}`} data-change-diff>
      <table>
        <tbody>
          {rows.map((r, i) => {
            if (r.k === 'hunk') {
              if (i === firstHunk && r.line <= 3) return null
              return <tr key={i} className="hunk"><td className="ln" /><td className="ln" /><td className="sg" /><td className="cd">{t('changes.diff.line', { n: r.line })}</td></tr>
            }
            if (r.k === 'more') return <tr key={i} className="hunk"><td className="ln" /><td className="ln" /><td className="sg" /><td className="cd">{t('changes.diff.more', { n: r.count })}</td></tr>
            return (
              <tr key={i} className={r.k}>
                <td className="ln">{r.o ?? ''}</td>
                <td className="ln">{r.n ?? ''}</td>
                <td className="sg">{r.k === 'add' ? '+' : r.k === 'del' ? '−' : ''}</td>
                <td className="cd">{r.marks ? r.marks.map((m, j) => (m.on ? <span key={j} className="w">{m.text}</span> : m.text)) : (r.text || ' ')}</td>
              </tr>
            )
          })}
          {truncated && <tr className="hunk"><td className="ln" /><td className="ln" /><td className="sg" /><td className="cd">{t('changes.diff.truncated')}</td></tr>}
        </tbody>
      </table>
    </div>
  )
})

/** +增 −删(比不了就不画)。 */
export function ChangeNums({ adds, dels }: { adds: number | null; dels: number | null }) {
  if (adds == null || dels == null) return null
  return (
    <span className="ct-nums">
      {adds > 0 && <span className="add">+{adds}</span>}
      {dels > 0 && <span className="del">−{dels}</span>}
      {!adds && !dels && <span>0</span>}
    </span>
  )
}
