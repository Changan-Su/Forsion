/** 知识网络索引的纯派生(L-13 / L-14 / L-16 / C-19):桌面主进程 `electron/amadeus/fs/vaultIndex.ts` 与移动端
 *  `mobile/src/amadeus/vaultIndex.ts` 两份 VaultIndex 共用 —— 口径只许在这里改一处。纯 JS(+ yaml),不碰 IO。 */
import { parse as parseYaml } from 'yaml'
import { AMADEUS_FM_KEY, fmEntries } from './compiler/split'
import { CODE_MASK, WIKILINK_RE, linkTarget, maskCode, normTag, parseWikiLinks, plainSnippet } from './links'
import { findMarkLine } from './mdMarks'
import type { BacklinkHit, MentionHit } from './ipc'

// 口径同 links.stripForIndex / compiler/split.stripFrontmatter(空 fm 合法、收尾栅栏独占一行、容 BOM)。
const FM_RE = /^﻿?---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

/** fm 里一个带 `[[ ]]` 的属性(C-19):key = 键名,text = 值的原文(去掉 `key:`),targets = 其中的链接目标。 */
export interface FmLinkProp {
  key: string
  text: string
  targets: string[]
}

export interface NoteFmMeta {
  /** `tags:` / `tag:`(列表、或逗号 / 空白分隔的字符串;去前导 `#`),与正文 #标签 合并进索引(L-14)。 */
  tags: string[]
  /** `aliases:` / `alias:`(列表、或逗号分隔的字符串),进 `[[` 补全与未链接提及(L-13 / L-16)。 */
  aliases: string[]
  /** 值里写了 `[[x]]` 的属性,计入出链 / 反链(C-19)。text 已去掉 YAML 引号 / 方括号(展示用)。 */
  links: FmLinkProp[]
}

const LIST_KEY = /^["']?(tags|tag|aliases|alias)["']?[ \t]*:/i

/** 标量 / 标量数组 → 字符串表(嵌套结构一律不认)。 */
function scalars(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (typeof v === 'number') return [String(v)]
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' || typeof x === 'number' ? [String(x)] : []))
  return []
}

/**
 * 从笔记原文抠 fm 的 tags / aliases / 链接属性。**只解析相关的顶层条目**(按 split.fmEntries 分组):
 * amadeus_* 大块 JSON(画布 / 布局)一个字都不过 YAML,整块坏 YAML 也只丢坏的那一条。
 * 链接按条目**原文**找 `[[ ]]` —— 不加引号的 `related: [[Beta]]` 在 YAML 里是嵌套数组,按值找就漏了。
 */
export function noteFmMeta(raw: string): NoteFmMeta {
  const out: NoteFmMeta = { tags: [], aliases: [], links: [] }
  const body = FM_RE.exec(raw)?.[1]
  if (!body || (!/^["']?(?:tags?|alias(?:es)?)["']?[ \t]*:/im.test(body) && !body.includes('[['))) return out
  const seenTag = new Set<string>()
  const seenAlias = new Set<string>()
  for (const e of fmEntries(body.replace(/\r?\n$/, '').split(/\r?\n/))) {
    const head = e[0]
    if (AMADEUS_FM_KEY.test(head)) continue
    const listKey = LIST_KEY.exec(head)?.[1]?.toLowerCase()
    const text = e.join('\n')
    if (listKey) {
      let v: unknown
      try {
        const obj = parseYaml(text) as Record<string, unknown> | null
        v = obj && typeof obj === 'object' ? Object.values(obj)[0] : undefined
      } catch {
        v = undefined // 这一条坏 YAML:只丢它
      }
      const isTag = listKey === 'tags' || listKey === 'tag'
      for (const s of scalars(v)) {
        for (const part of s.split(isTag ? /[,\s]+/ : /,/)) {
          if (isTag) {
            const t = normTag(part)
            if (t && !seenTag.has(t.toLowerCase())) { seenTag.add(t.toLowerCase()); out.tags.push(t) }
          } else {
            const a = part.trim()
            if (a && !seenAlias.has(a.toLowerCase())) { seenAlias.add(a.toLowerCase()); out.aliases.push(a) }
          }
        }
      }
    }
    if (text.includes('[[')) {
      const m = /^(["']?)(.+?)\1[ \t]*:(?=[ \t]|$)/.exec(head)
      if (!m) continue
      const value = text.slice(m[0].length).trim()
      const targets = parseWikiLinks(value)
      // 展示用:块状列表逐项拼成「a, b」,去掉 flow 方括号与项两端的 YAML 引号。
      const shown = value.split('\n').map((l) => l.trim().replace(/^-\s+/, '')).filter(Boolean).join(', ')
        .replace(/^\[(.*)\]$/, '$1')
        .replace(/(^|,\s*)(["'])(.*?)\2(?=\s*(?:,|$))/g, '$1$3')
      if (targets.length) out.links.push({ key: m[2], text: shown, targets })
    }
  }
  return out
}

/**
 * 一篇笔记里所有解析到目标的 `[[链接]]`,**逐处**列出(L-16):每行一条(一行两处算一条上下文),代码里的不算。
 * plain = 解码后的清洗正文;isMatch = 该链接目标按源笔记上下文解析后是不是目标页(与 backlinks 同一判据)。
 */
export function backlinkHits(plain: string, isMatch: (target: string) => boolean, limit = 50): BacklinkHit[] {
  if (!plain.includes('[[')) return []
  const lines = plain.split('\n')
  const masked = maskCode(plain).split('\n')
  const out: BacklinkHit[] = []
  for (let i = 0; i < masked.length && out.length < limit; i++) {
    if (!masked[i].includes('[[')) continue
    const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(masked[i]))) {
      if (!isMatch(linkTarget(m[1]))) continue
      out.push({ line: i + 1, text: plainSnippet(lines[i]).slice(0, 240) })
      break
    }
  }
  return out
}

const isAsciiWord = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_]/.test(c)

/** 已经是链接 / 地址的段抹掉,不许再算「未链接提及」:`[[ ]]` / `![[ ]]`、md 链接与图片、裸 URL、HTML 标签。 */
function maskLinked(line: string): string {
  const blank = (m: string): string => CODE_MASK.repeat(m.length)
  return line
    .replace(/!?\[\[[^\]\n]*\]\]/g, blank)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/\b(?:https?|file|amadeus-asset):\/\/\S+/gi, blank)
    .replace(/<\/?[A-Za-z][^>\n]*>/g, blank)
}

/**
 * 提到了 names(本页标题 + 别名)却没加 `[[ ]]` 的地方(L-16),每行一条。大小写不敏感;名字首 / 尾是 ASCII 词字符时
 * 要求词边界(`Target` 不命中 `Targets`),中文名不设边界。代码、已有链接、URL、HTML 标签里的不算。
 * text = 与 plain 逐行对齐的**原文**(未解字符引用):该行两者一致才给 raw/occ/col/match(可一键链接),
 * 否则只展示(列位对不上,宁可不给按钮也不许改错位置)。
 */
export function mentionHits(plain: string, text: string, names: string[], limit = 50): MentionHit[] {
  const keys = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2 || /[^\x00-\x7f]/.test(n)))]
    .sort((a, b) => b.length - a.length)
    .map((n) => ({ n, low: n.toLowerCase() }))
  if (!keys.length) return []
  const lower = plain.toLowerCase()
  if (!keys.some((k) => lower.includes(k.low))) return []
  const lines = plain.split('\n')
  const rawLines = text.split('\n')
  const masked = maskCode(plain).split('\n')
  const seen = new Map<string, number>()
  const out: MentionHit[] = []
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const raw = rawLines[i] ?? ''
    const occ = seen.get(raw) ?? 0
    seen.set(raw, occ + 1)
    const hay = maskLinked(masked[i] ?? '').toLowerCase()
    // 行内最靠前的一处(同位置取最长的名字,keys 已按长度降序)。
    let hit: { col: number; len: number } | null = null
    for (const k of keys) {
      for (let at = hay.indexOf(k.low); at >= 0 && (!hit || at < hit.col); at = hay.indexOf(k.low, at + 1)) {
        if (isAsciiWord(k.n[0]) && isAsciiWord(hay[at - 1])) continue
        if (isAsciiWord(k.n[k.n.length - 1]) && isAsciiWord(hay[at + k.low.length])) continue
        hit = { col: at, len: k.low.length }
        break
      }
    }
    if (!hit) continue
    const h: MentionHit = { line: i + 1, text: plainSnippet(lines[i]).slice(0, 240) }
    // toLowerCase 可能改变长度(少数字符)→ 列位不可靠时同样只展示
    if (raw === lines[i] && lines[i].toLowerCase().length === lines[i].length) {
      Object.assign(h, { raw, occ, col: hit.col, match: lines[i].slice(hit.col, hit.col + hit.len) })
    }
    out.push(h)
  }
  return out
}

/**
 * 把一处未链接提及改写成 `[[inner]]`(L-16「一键链接」;主进程 linkMention 在同篇路径锁内调用)。
 * 定位**按内容**:raw + occ 找行(mdMarks.findMarkLine,与 patchMark 同一把尺子),再核 [col, col+match) 的原文 ——
 * 任何一步对不上 = null 不写(文件在列出之后被改过),**绝不模糊匹配**。inner 带 `]` 或换行也拒。
 */
export function linkMentionInText(
  fileText: string,
  hit: { raw: string; occ: number; col: number; match: string },
  inner: string,
): string | null {
  if (!inner.trim() || /[\]\r\n]/.test(inner) || !hit.match) return null
  const at = findMarkLine(fileText, hit.raw, hit.occ)
  if (at < 0) return null
  const eol = fileText.includes('\r\n') ? '\r\n' : '\n'
  const lines = fileText.split(/\r?\n/)
  const line = lines[at]
  if (line.slice(hit.col, hit.col + hit.match.length) !== hit.match) return null
  lines[at] = `${line.slice(0, hit.col)}[[${inner}]]${line.slice(hit.col + hit.match.length)}`
  return lines.join(eol)
}
