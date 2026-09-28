/**
 * 远程会话最高审批档:桌面写的格式 = 引擎读的格式(P1 · K4 §3.1-B / C3)。
 * 桌面主进程用 withRemoteCap + 跨进程写锁(configWrite.lockedUpdateJson,main.ts 的 updateHomeConfig)写 config.json;
 * 引擎 remoteApprovalCap() 每次工具调用现读同一个键。这里两头都用真代码:写完用引擎的读函数读回来。
 * 跑法:npx vitest run electron/remoteCapFormat.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockedUpdateJson } from './configWrite'
import { withRemoteCap } from './remoteSessions'
import { remoteApprovalCap } from '../../tangu-agent/src/services/remoteOrigin'

let home: string
const prev = process.env.TANGU_HOME
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'forsion-remote-cap-')); process.env.TANGU_HOME = home })
afterAll(() => { if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev; rmSync(home, { recursive: true, force: true }) })

describe('remote.maxApprovalMode:桌面写 → 引擎读', () => {
  it('三档逐一写入,引擎读回同一档;其他段与 remote 段的其他键原样保留', async () => {
    const file = join(home, 'config.json')
    writeFileSync(file, JSON.stringify({ cloud: { url: 'https://c.test' }, remote: { futureKey: 1 }, approval: { base: 'readonly' } }))
    expect(remoteApprovalCap()).toBe('auto-edit') // 缺省
    for (const m of ['readonly', 'full-auto', 'auto-edit'] as const) {
      await lockedUpdateJson(file, (h) => withRemoteCap(h, m))
      expect(remoteApprovalCap(), m).toBe(m)
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ cloud: { url: 'https://c.test' }, remote: { futureKey: 1, maxApprovalMode: 'auto-edit' }, approval: { base: 'readonly' } })
  })

  it('remote 段是坏值(数组 / 字符串)→ 换成只含这一键的新段,引擎照读', async () => {
    const file = join(home, 'config.json')
    for (const bad of [['x'], 'oops', null]) {
      writeFileSync(file, JSON.stringify({ remote: bad }))
      await lockedUpdateJson(file, (h) => withRemoteCap(h, 'readonly'))
      expect(JSON.parse(readFileSync(file, 'utf8')).remote).toEqual({ maxApprovalMode: 'readonly' })
      expect(remoteApprovalCap()).toBe('readonly')
    }
  })
})
