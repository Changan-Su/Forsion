/**
 * 文件类型工具:图标 / 预览种类 / 语言识别 / CSV 解析 / base64↔字节。
 * 移植精简自 Forsion-AI-Studio client/services/fileTypes.ts(去掉 hljs 直依赖,
 * 代码高亮交给现有 <Markdown> 围栏渲染)。供 WorkspaceFilePreview 与 RightPanel 共用。
 */
import {
  FileText, FileImage, FileCode, FileSpreadsheet, FileVideo, FileAudio, FileArchive, Presentation,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ── 路径 / 体积 ────────────────────────────────────────────────────────────────

export function extOf(path: string): string {
  const base = path.split('/').pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export function baseOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? path : path.slice(i + 1)
}

export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** base64(无 dataURL 前缀)→ 字节。 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ext → 最可信 MIME。服务端推断常不准:云端未知类型回 text/plain、本机回 octet-stream,
// 媒体直接喂进 <video>/<audio> 会因 type 错而拒播,故按扩展名兜底。
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf',
}
/** ext → MIME(媒体 / PDF 的 blob type 用;认不出回 null)。 */
export function mimeForExt(path: string): string | null {
  return MIME_BY_EXT[extOf(path)] ?? null
}
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']
const VID_EXT = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi']
const AUD_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']

// ── 图标 ───────────────────────────────────────────────────────────────────────

const CODE_EXTS = [
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'swift',
  'cpp', 'cc', 'c', 'h', 'hpp', 'rb', 'php', 'sh', 'bash', 'yaml', 'yml',
  'xml', 'toml', 'ini', 'css', 'scss', 'sass', 'less', 'sql', 'vue',
]

export function iconForFile(mime: string, path: string): LucideIcon {
  const ext = extOf(path)
  if (mime.startsWith('image/')) return FileImage
  if (mime.startsWith('video/')) return FileVideo
  if (mime.startsWith('audio/')) return FileAudio
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(ext)) return FileArchive
  if (['xls', 'xlsx', 'csv', 'tsv', 'numbers', 'ods'].includes(ext)) return FileSpreadsheet
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return Presentation
  if (CODE_EXTS.includes(ext) || ['html', 'htm', 'json'].includes(ext)) return FileCode
  return FileText
}

// ── 预览种类(单一出处) ─────────────────────────────────────────────────────────

export type PreviewKind =
  | 'html' | 'code' | 'markdown' | 'image' | 'pdf' | 'csv' | 'json'
  | 'video' | 'audio' | 'text' | 'docx' | 'xlsx' | 'pptx' | 'diff' | 'binary'

const TEXT_CODE_EXTS = [...CODE_EXTS, 'log']

export function previewKindFor(mime: string, path: string): PreviewKind {
  const ext = extOf(path)
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/') || IMG_EXT.includes(ext)) return 'image'
  if (m.startsWith('video/') || VID_EXT.includes(ext)) return 'video'
  if (m.startsWith('audio/') || AUD_EXT.includes(ext)) return 'audio'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  // OOXML(zip 容器)— 懒加载 mammoth/SheetJS/JSZip 渲染。旧二进制 .doc/.ppt 走 binary 兜底。
  if (ext === 'docx') return 'docx'
  if (['xlsx', 'xls', 'xlsm'].includes(ext)) return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  if (m === 'text/html' || ext === 'html' || ext === 'htm') return 'html'
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
  if (['diff', 'patch'].includes(ext)) return 'diff'
  if (['csv', 'tsv'].includes(ext)) return 'csv'
  if (m === 'application/json' || ext === 'json') return 'json'
  if (TEXT_CODE_EXTS.includes(ext)) return 'code'
  if (m.startsWith('text/') || ['txt'].includes(ext)) return 'text'
  return 'binary'
}

// 围栏代码高亮的语言提示(对齐 rehype-highlight 默认 common 语言集)。
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', kt: 'kotlin', rs: 'rust',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  scss: 'css', sass: 'css', less: 'css',
  json5: 'json', jsonc: 'json',
  sh: 'bash', zsh: 'bash', shell: 'bash',
  yml: 'yaml', toml: 'ini',
}

/** ext → 一个 highlight.js 认得的语言名(认不出就回 ext 原样)。 */
export function languageForExt(ext: string): string {
  return LANG_ALIASES[ext] ?? ext
}

// ── CSV / TSV(支持引号字段 + 转义引号) ─────────────────────────────────────────

export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === delim) { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}
