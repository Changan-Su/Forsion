/**
 * 真 osascript 跑 MAC_DRIVER_SCRIPT,但只碰**私有命名剪贴板**、不发按键(驱动在命名剪贴板上自己就不发 ⌘V)——
 * 用户的系统剪贴板和此刻在前台的应用都不受影响。只在 macOS 上跑。
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createMacDriver } from './macDriver'

const mac = process.platform === 'darwin'
const board = `com.forsion.dictation.test.${randomUUID()}`

function jxa(body: string): string {
  return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var pb = $.NSPasteboard.pasteboardWithName($(${JSON.stringify(board)})); ${body}`], { encoding: 'utf8' }).trim()
}
/** 两项、三种类型:一项文字 + 自定义二进制,另一项只有自定义类型 —— 还原必须原样带回。 */
function seed(): void {
  jxa(`pb.clearContents
    var a = $.NSPasteboardItem.alloc.init
    a.setStringForType($('before 剪贴板'), $.NSPasteboardTypeString)
    a.setDataForType($('keep-a').dataUsingEncoding($.NSUTF8StringEncoding), $('com.forsion.test.a'))
    var b = $.NSPasteboardItem.alloc.init
    b.setDataForType($('keep-b').dataUsingEncoding($.NSUTF8StringEncoding), $('com.forsion.test.b'))
    var arr = $.NSMutableArray.alloc.init; arr.addObject(a); arr.addObject(b); pb.writeObjects(arr); ''`)
}
function read(): Array<Record<string, string>> {
  return JSON.parse(jxa(`var out = [], items = pb.pasteboardItems, n = Number(items.count)
    for (var i = 0; i < n; i++) { var it = items.objectAtIndex(i), ts = it.types, m = Number(ts.count), o = {}
      for (var j = 0; j < m; j++) { var t = ts.objectAtIndex(j); o[ObjC.unwrap(t)] = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(it.dataForType(t), $.NSUTF8StringEncoding)) }
      out.push(o) }
    JSON.stringify(out)`))
}

describe.skipIf(!mac)('macOS dictation driver (private pasteboard, no keystrokes)', () => {
  const driver = createMacDriver()
  afterAll(() => { try { jxa('pb.releaseGlobally; ""') } catch { /* ignore */ } })

  it('probe and front answer without throwing', async () => {
    const p = await driver.probe()
    expect(typeof p.ax).toBe('boolean')
    expect(typeof p.secure).toBe('boolean')
    const f = await driver.front()
    if (f) expect(f.pid).toBeGreaterThan(0)
  }, 20_000)

  it('restores every item and type when nobody touched the clipboard', async () => {
    seed()
    const before = read()
    const r = await driver.insert({ text: '今天讨论了三件事。', pasteboard: board, checks: false, settle: 0.05 })
    expect(r).toEqual({ outcome: 'pasted', restored: true })
    expect(read()).toEqual(before)
    expect(before).toEqual([
      { 'public.utf8-plain-text': 'before 剪贴板', 'com.forsion.test.a': 'keep-a' },
      { 'com.forsion.test.b': 'keep-b' },
    ])
  }, 20_000)

  it('leaves the clipboard alone when something else changed it after the paste', async () => {
    seed()
    const r = await driver.insert({ text: 'dictated', pasteboard: board, checks: false, settle: 0.05, mutateAfterPost: 'copied by the user meanwhile' })
    expect(r).toEqual({ outcome: 'pasted', restored: 'changed' })
    expect(read()).toEqual([{ 'public.utf8-plain-text': 'copied by the user meanwhile' }])
  }, 20_000)

  it('an empty clipboard stays empty', async () => {
    jxa('pb.clearContents; ""')
    const r = await driver.insert({ text: 'x', pasteboard: board, checks: false, settle: 0.05 })
    expect(r).toEqual({ outcome: 'pasted', restored: 'empty' })
    expect(read()).toEqual([])
  }, 20_000)

  it('a copy the user makes while the snapshot is read wins: nothing is written over it', async () => {
    seed()
    const r = await driver.insert({ text: 'dictated', pasteboard: board, checks: false, settle: 0.05, mutateBeforeWrite: 'copied while we read' })
    expect(r).toEqual({ outcome: 'paste-failed', detail: 'clipboard changed' })
    expect(read()).toEqual([{ 'public.utf8-plain-text': 'copied while we read' }])
  }, 20_000)

  it('a type that never materializes means no paste (restoring the readable part would drop it)', async () => {
    // A promised type with no provider, declared by a process that stays alive (once it exits the system drops the promise).
    const holder = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var pb = $.NSPasteboard.pasteboardWithName($(${JSON.stringify(board)}))
      pb.clearContents; var a = $.NSPasteboardItem.alloc.init; a.setStringForType($('before 剪贴板'), $.NSPasteboardTypeString)
      var arr = $.NSMutableArray.alloc.init; arr.addObject(a); pb.writeObjects(arr)
      pb.addTypesOwner($(['com.forsion.test.lazy']), $()); delay(8); ''`], { stdio: 'ignore' })
    try {
      const types = (): string[] => JSON.parse(jxa(`JSON.stringify(ObjC.deepUnwrap(pb.types) || [])`))
      for (let i = 0; i < 40 && !types().includes('com.forsion.test.lazy'); i++) await new Promise((r) => setTimeout(r, 50))
      expect(types()).toContain('com.forsion.test.lazy')
      const r = await driver.insert({ text: 'dictated', pasteboard: board, checks: false, settle: 0.05 })
      expect(r).toEqual({ outcome: 'paste-failed', detail: 'clipboard not fully readable' })
      expect(types()).toContain('com.forsion.test.lazy')
      expect(jxa(`ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString))`)).toBe('before 剪贴板')
    } finally { holder.kill() }
  }, 20_000)

  it('when the last check before the keystroke fails, the user\'s clipboard is put back', async () => {
    seed()
    const before = read()
    const r = await driver.insert({ text: 'dictated', pasteboard: board, checks: false, settle: 0.05, failBeforePost: true })
    expect(r).toEqual({ outcome: 'target-changed', detail: 'test' })
    expect(read()).toEqual(before)
  }, 20_000)

  it('writes the exact text, marked transient for clipboard managers', async () => {
    const text = '引号 "quoted" \\ back\nnew line 🎙️'
    expect(await driver.copy(text, board)).toBe(true)
    expect(read()).toEqual([{ 'public.utf8-plain-text': text }])
  }, 20_000)

  it('with checks on, a target that is not in front is refused before the clipboard is touched', async () => {
    seed()
    const before = read()
    const r = await driver.insert({ text: 'nope', pasteboard: board, target: { pid: 999_999 } })
    expect(r.outcome).toBe('target-changed')
    expect(read()).toEqual(before)
  }, 20_000)
})
