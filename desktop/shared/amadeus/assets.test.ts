/** 图片链接的 display ↔ stored 往返(2026-08-27 用户实报「原来的图片文件都无法被引用了」)。
 *
 *  病根:粘贴一张名字带空格的图,编辑器序列化出 `![](amadeus-asset://…)`,这里换回相对路径时
 *  **原样**写下 `![](attachments/a b.png)` —— 而 CommonMark 的链接目标遇空格即止,这不是合法图片。
 *  remark 于是当纯文本读,下一次保存又给 `[`/`(` 加反斜杠 → 盘上永久变成 `!\[]\(…)` 一行死字。
 *  所以本文件钉的是:**写出去的一定是合法 markdown 目标**(空格/括号一律百分号编码)。
 *
 *  ⚠️ 方向很重要:真实链路是 display(协议 URL)→ stored,不是「盘上裸空格 → 盘上」——
 *  裸空格那种压根匹配不上 IMG_RE(见最后一格),那是**存量受损文件**,只能靠修复扫描,别指望这里自愈。 */
import { describe, it, expect } from 'vitest'
import { toDisplayMarkdown, toStoredMarkdown, assetRefs, toAssetUrl } from './assets'

/** 编辑器序列化出来的那一行(PM 的 image 节点 src 就是协议 URL)。 */
const disp = (ref: string): string => `![](${toAssetUrl(ref)})`

describe('图片链接 display → stored(落盘)', () => {
  it('普通文件名原样不动(不给存量文件制造无谓改动)', () => {
    expect(toStoredMarkdown(disp('attachments/pic.png'), '')).toBe('![](attachments/pic.png)')
  })

  it('⚠️名字带空格 → 落盘必须是 %20,绝不许留裸空格', () => {
    const out = toStoredMarkdown(disp('attachments/Screenshot 2026-08-27 at 22.25.59.png'), '')
    expect(out).toBe('![](attachments/Screenshot%202026-08-27%20at%2022.25.59.png)')
    expect(out).not.toMatch(/\]\([^)]* /)
  })

  it('⚠️名字带括号 → 一并编码(`export (1).png` 是真实存量文件名;裸括号会被 IMG_RE 截断)', () => {
    expect(toStoredMarkdown(disp('attachments/export (1).png'), '')).toBe('![](attachments/export%20%281%29.png)')
  })

  it('页目录相对化仍然生效', () => {
    expect(toStoredMarkdown(disp('笔记.fd/attachments/a b.png'), '笔记.fd')).toBe('![](attachments/a%20b.png)')
  })
})

describe('图片链接 stored → display(读盘)', () => {
  it('解码后再拼协议 URL —— 不解码会二次编码,协议侧就找不到文件', () => {
    const out = toDisplayMarkdown('![](attachments/a%20b.png)', '笔记.fd')
    expect(out).toBe(disp('笔记.fd/attachments/a b.png'))
    expect(out).not.toContain('%2520')
  })

  it('外链原样不动', () => {
    const ext = '![封面](https://example.com/a.jpg)'
    expect(toDisplayMarkdown(ext, '')).toBe(ext)
  })

  it('文件名里字面含 % 不许把函数搞崩(decodeURIComponent 遇裸 % 会抛)', () => {
    expect(() => toDisplayMarkdown('![](attachments/100%.png)', '')).not.toThrow()
  })
})

describe('往返稳定 + 账目', () => {
  it('落盘形态再走一圈必须字节稳定(编解码互为逆,不许每次保存都改字节)', () => {
    const stored = '![](attachments/a%20b%20%281%29.png)'
    expect(toStoredMarkdown(toDisplayMarkdown(stored, ''), '')).toBe(stored)
  })

  it('附件账目:媒体时刻锚 `#t=` 不影响独占计数(否则删笔记会漏算/错删)', () => {
    expect(assetRefs('![[lecture.mp4#t=95]]')).toEqual(['lecture.mp4'])
    expect(assetRefs('[[lecture.mp4#t=95|01:35]]')).toEqual(['lecture.mp4'])
    expect(assetRefs('[01:35](lecture.mp4#t=95)')).toEqual(['lecture.mp4'])
    // 同一份素材被多条时间戳引用 → 仍只算一条,不重复计数
    expect(assetRefs('![[a.m4a]] [[a.m4a#t=10|00:10]] [[a.m4a#t=20|00:20]]')).toEqual(['a.m4a'])
  })

  it('附件账目:`![[https://…]]` 网页嵌入不是 vault 附件(别把外链算进删除计数)', () => {
    expect(assetRefs('![[https://example.com/page]]')).toEqual([])
    expect(assetRefs('![[https://example.com/a.mp4]]')).toEqual([])
  })

  it('附件账目(assetRefs)认得编码过的引用 —— 否则删笔记时会漏算独占附件', () => {
    expect(assetRefs('![](attachments/a%20b.png)')).toEqual(['attachments/a b.png'])
  })

  it('⚠️已经写坏的存量文件(目标里裸空格)本层修不了 —— 匹配不上 IMG_RE,只能靠修复扫描', () => {
    const damaged = '![](attachments/a b.png)'
    expect(toDisplayMarkdown(damaged, '')).toBe(damaged) // 原样穿过 = 之后仍会被 remark 当文本转义
  })
})
