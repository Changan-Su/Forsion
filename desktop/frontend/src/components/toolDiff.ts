/**
 * 文件修改类工具参数 → unified diff 文本(工具卡详情 + 审批卡写前预览共用)。
 * edit/multi_edit 是「声称的 old→new」快照 diff,不读真实文件;write_file 全为新增。
 * 构不出(非文件工具 / 参数坏 / 超大)返回 null,调用方回退裸参数展示。
 */
import { createTwoFilesPatch } from 'diff'

// ponytail: 超大内容跳过 diff 回退裸参数;真卡了再上 worker/截断渲染
const MAX_DIFF_INPUT = 200_000

const patchOf = (path: string, oldStr: string, newStr: string): string =>
  createTwoFilesPatch(path, path, oldStr, newStr, undefined, undefined, { context: 3 })

/**
 * codex apply_patch 方言 → unified diff,**仅供展示**(语法正典=tangu-agent/src/tools/applyPatch.ts,
 * 前端不 import 引擎源码,故此处独立实现宽容子集)。hunk 行号无从得知,一律标 -1/+1 —— 与
 * edit_file 的片段 diff 同一语义(行号是片段相对,不是文件行号)。
 */
export function codexPatchToUnified(patch: string): string | null {
  if (!/^\*\*\* (Begin Patch|(Add|Update|Delete) File:)/m.test(patch)) return null
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const SECTION = /^\*\*\* (Add|Update|Delete) File: (.+)$/
  const isHeader = (l: string) => SECTION.test(l) || /^\*\*\* (Begin|End) Patch$/.test(l.trim())
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = SECTION.exec(lines[i])
    if (!m) { i++; continue }
    const kind = m[1], p = m[2].trim()
    i++
    let move = ''
    const mv = kind === 'Update' ? /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? '') : null
    if (mv) { move = mv[1].trim(); i++ }
    const body: string[] = []
    while (i < lines.length && !isHeader(lines[i])) { body.push(lines[i]); i++ }
    if (kind === 'Delete') {
      out.push(`--- ${p}`, '+++ /dev/null', '@@ -1,1 +0,0 @@', '-(deleted)')
      continue
    }
    if (kind === 'Add') {
      const adds = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1))
      if (!adds.length) continue
      out.push('--- /dev/null', `+++ ${p}`, `@@ -0,0 +1,${adds.length} @@`, ...adds.map((l) => '+' + l))
      continue
    }
    // Update:按 @@ 切 hunk;' '/'-'/'+' 前缀,无前缀按上下文(对齐引擎宽容解析)
    const file: string[] = [`--- ${p}`, `+++ ${move || p}`]
    let hunk: string[] = []
    let ctxHeader = ''
    const flush = (): void => {
      if (!hunk.length) return
      const olds = hunk.filter((l) => l[0] !== '+').length
      const news = hunk.filter((l) => l[0] !== '-').length
      file.push(`@@ -1,${olds} +1,${news} @@${ctxHeader ? ' ' + ctxHeader : ''}`, ...hunk)
      hunk = []
    }
    for (const l of body) {
      const at = /^@@ ?(.*)$/.exec(l)
      if (at) { flush(); ctxHeader = at[1] || ''; continue }
      if (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')) hunk.push(l)
      else hunk.push(' ' + l)
    }
    flush()
    if (file.length > 2) out.push(...file)
  }
  return out.length ? out.join('\n') + '\n' : null
}

/** 从工具名+JSON 参数构造 unified diff;构不出返回 null。 */
export function toolDiffText(name: string, argsJson: string | undefined): string | null {
  if (!argsJson) return null
  let a: any
  try { a = JSON.parse(argsJson) } catch { return null }
  if (!a || typeof a !== 'object') return null
  const path = typeof a.path === 'string' && a.path ? a.path : 'file'
  try {
    switch (name) {
      case 'edit_file': {
        const oldS = String(a.old_string ?? ''), newS = String(a.new_string ?? '')
        if (!oldS && !newS) return null
        if (oldS.length + newS.length > MAX_DIFF_INPUT) return null
        return patchOf(path, oldS, newS)
      }
      case 'multi_edit': {
        if (!Array.isArray(a.edits) || !a.edits.length) return null
        let total = 0
        const parts: string[] = []
        for (let i = 0; i < a.edits.length; i++) {
          const e = a.edits[i]
          const oldS = String(e?.old_string ?? ''), newS = String(e?.new_string ?? '')
          total += oldS.length + newS.length
          if (total > MAX_DIFF_INPUT) return null
          parts.push(patchOf(a.edits.length > 1 ? `${path} · #${i + 1}` : path, oldS, newS))
        }
        return parts.join('\n')
      }
      case 'write_file': {
        const content = String(a.content ?? '')
        if (!content || content.length > MAX_DIFF_INPUT) return null
        return patchOf(path, '', content)
      }
      case 'apply_patch': {
        const patch = String(a.patch ?? a.input ?? a.diff ?? '')
        if (patch.length > MAX_DIFF_INPUT) return null
        // 标准 unified diff 直接透传;否则按 codex 方言(引擎实际使用的格式)翻译
        if (/^@@[ -]/m.test(patch) && /^(--- |\+\+\+ )/m.test(patch)) return patch
        return codexPatchToUnified(patch)
      }
      default:
        return null
    }
  } catch { return null }
}
