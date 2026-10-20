/** 挪动途中按住编辑器(holdUnifiedPath)按路径认实例:Windows 上树里的行是 listPages 原样的 `\`,挪过一次之后开着的编辑器
 *  登记的是主进程回的 `/` —— 只比字面就认不出来(10-19 Windows e2e:notemove 拖回那步红:不按住、标签不跟、字进了冲突副本)。 */
import { expect, it } from 'vitest'
import { holdUnifiedPath, pathHit, registerUnifiedPipe } from './lifecycle'

it('路径身份不认分隔符;子树按整段认', () => {
  expect(pathHit('目标夹/带图.md', '目标夹\\带图.md')).toBe(true)
  expect(pathHit('目标夹\\带图.md', '目标夹/带图.md')).toBe(true)
  expect(pathHit('a/b/c.md', 'a\\b', 'prefix')).toBe(true)
  expect(pathHit('a/bc.md', 'a/b', 'prefix')).toBe(false)
  expect(pathHit('a/b/c.md', 'a/b')).toBe(false)
})

it('按 `\\` 路径按住 → 按 `/` 登记的编辑器被按住,放手时拿到新路径', async () => {
  const calls: string[] = []
  const off = registerUnifiedPipe({
    path: '目标夹/带图.md',
    flush: async () => {},
    retire: () => {},
    hold: async () => { calls.push('hold') },
    release: async (to) => { calls.push(`release:${to}`) },
  })
  const release = await holdUnifiedPath('目标夹\\带图.md')
  await release('来源夹/带图.md')
  off()
  expect(calls).toEqual(['hold', 'release:来源夹/带图.md'])
})
