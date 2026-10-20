/** 挪动途中打的字交接到新路径(holdUnifiedPath → UnifiedPage.handOver):与主进程改写过引用的那版按行三方合并。
 *  整条链在 desktop 的 npm run e2e:notemove;这里只钉合并本身:能合的合上,同一行两边都改了交回 null(调用方落冲突副本)。 */
import { afterEach, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  vi.stubGlobal('window', { dispatchEvent: () => true, amadeus: {} })
  return import('./writeSafety')
}
afterEach(() => { vi.unstubAllGlobals() })

const BASE = '# 带图\n\n正文一行\n\n![](.amadeus/p.png)\n\n[doc](attachments/d.pdf)\n'
const MOVED = BASE.replace('](.amadeus/', '](../来源夹/.amadeus/').replace('](attachments/', '](../来源夹/attachments/')

it('挪动途中打的字并进主进程改写过的引用(两边各改各的行)', async () => {
  const { mergeMovedText } = await load()
  const typed = BASE.replace('正文一行', '正文一行续写') + '\n新起一段\n'
  expect(mergeMovedText(BASE, typed, MOVED)).toBe(MOVED.replace('正文一行', '正文一行续写') + '\n新起一段\n')
})

it('CRLF 照样合(两边都是盘上字节)', async () => {
  const { mergeMovedText } = await load()
  const crlf = (s: string) => s.replace(/\n/g, '\r\n')
  expect(mergeMovedText(crlf(BASE), crlf(BASE.replace('正文一行', '正文一行续写')), crlf(MOVED))).toBe(crlf(MOVED.replace('正文一行', '正文一行续写')))
})

it('就在被改写的那行上打字 → 合不拢,交回 null', async () => {
  const { mergeMovedText } = await load()
  expect(mergeMovedText(BASE, BASE.replace('![](.amadeus/p.png)', '![](.amadeus/p.png) 图注'), MOVED)).toBeNull()
})
