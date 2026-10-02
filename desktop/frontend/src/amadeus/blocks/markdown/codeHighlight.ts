/** 代码语言识别与高亮共用一份 grammar；猜测只用于视图，不写回 Markdown。 */
import { common, createLowlight } from 'lowlight'

const lowlight = createLowlight(common)
const TOP = ['javascript', 'typescript', 'python', 'bash', 'json', 'html', 'css', 'sql', 'java', 'go', 'rust', 'c', 'cpp', 'yaml', 'markdown', 'diff']
export const CODE_LANGUAGES = [...TOP, ...lowlight.listLanguages().filter((l) => !TOP.includes(l) && l !== 'plaintext').sort()]
const AUTO_LANGUAGES = CODE_LANGUAGES.filter((l) => !['markdown', 'ini', 'less', 'scss', 'vbnet', 'arduino', 'shell', 'python-repl', 'php-template'].includes(l))
const SAMPLE_LIMIT = 4096

export interface TokenRange { from: number; to: number; cls: string }
export interface CodeHighlight { language: string; ranges: TokenRange[] }
interface HastText { type: 'text'; value: string }
interface HastElement { type: 'element'; children?: HastAny[]; properties?: { className?: string[] } }
type HastAny = HastText | HastElement

/** 实际高亮/识别次数，check:editorperf 检查块外输入不重算。 */
let highlightRuns = 0
export function codeHighlightRuns(): number { return highlightRuns }
export function isPlainCodeLanguage(language: string): boolean {
  return ['text', 'txt', 'plaintext'].includes(language.toLowerCase())
}

/** 少量明确的声明消除 grammar 打分相同的歧义（JS/TS、Java、C/C++、Rust/Swift）。
 *  其余交给 lowlight；不给普通短句硬猜语言。匹配只扫描前 4096 字符，长代码仍全量高亮。 */
function distinctiveLanguage(code: string): string {
  if (/^\s*[\[{]/.test(code)) {
    try { JSON.parse(code); return 'json' } catch { /* 未完成的 JSON 仍交给 grammar。 */ }
  }
  if (/^\s*(?:export\s+)?(?:interface\s+\w+\s*(?:extends\b[^\n{]*)?\{|type\s+\w+\s*=|(?:const|let)\s+[\w$]+\s*:\s*[\w$][^=\n]*=)/m.test(code)) return 'typescript'
  if (/^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->[^:\n]+)?\s*:/m.test(code)) return 'python'
  if (/^\s*public\s+(?:final\s+)?class\s+\w+[^{\n]*\{|\bSystem\.out\.(?:print|println)\s*\(/m.test(code)) return 'java'
  if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+\s*\(/m.test(code)) return 'rust'
  if (/\bstd::\w+|^\s*#include\s*<\s*(?:iostream|vector|map|unordered_map|string|memory)\s*>/m.test(code)) return 'cpp'
  if (/^\s*#include\s*<\s*(?:stdio|stdlib|string)\.h\s*>/m.test(code)) return 'c'
  if (/^\s*import\s+(?:Foundation|SwiftUI|UIKit)\b/m.test(code)) return 'swift'
  if (/^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=/m.test(code)) return 'javascript'
  return ''
}

/** hast 树 → 按文本偏移的 class 区间；纯文本、不认识的语言或解析失败都安全回落。 */
export function highlightCode(code: string, requestedLanguage: string): CodeHighlight {
  const requested = requestedLanguage.trim()
  const empty = { language: '', ranges: [] }
  if (!code || isPlainCodeLanguage(requested)) return empty
  try {
    let language = requested
    let tree
    if (language) {
      if (!lowlight.registered(language)) return empty
      highlightRuns++
      tree = lowlight.highlight(language, code)
    } else {
      const sample = code.slice(0, SAMPLE_LIMIT)
      language = distinctiveLanguage(sample)
      highlightRuns++
      if (language) tree = lowlight.highlight(language, code)
      else {
        tree = lowlight.highlightAuto(sample, { subset: AUTO_LANGUAGES })
        if (!tree.data?.language || (tree.data.relevance ?? 0) < 3) return empty
        language = tree.data.language
        if (sample.length < code.length) {
          highlightRuns++
          tree = lowlight.highlight(language, code)
        }
      }
    }
    const ranges: TokenRange[] = []
    let off = 0
    const walk = (nodes: HastAny[], classes: string[]): void => {
      for (const node of nodes) {
        if (node.type === 'text') {
          if (classes.length && node.value.length) ranges.push({ from: off, to: off + node.value.length, cls: classes.join(' ') })
          off += node.value.length
        } else if (node.type === 'element') walk(node.children ?? [], [...classes, ...(node.properties?.className ?? [])])
      }
    }
    walk(tree.children as HastAny[], [])
    return { language, ranges }
  } catch { return empty }
}
