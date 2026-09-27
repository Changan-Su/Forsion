/**
 * 设备 MCP 保留命名空间(dev / dev_*):桌面写入口(mcp:write、发现导入、设置页编辑)的判定。
 * 与引擎 tangu-agent/src/mcp/config.ts isReservedServerName 同口径(按桥接消毒后的形态、不分大小写),
 * 另外把恰好等于 `dev` 的也收进来(契约:'dev' / 'dev_*')。
 */
import { describe, expect, it } from 'vitest'
import { isReservedMcpServerName, newReservedMcpNames, sanitizeMcpServerName } from './mcpNames'

describe('MCP 保留名', () => {
  it('dev / dev_* 按消毒后形态、不分大小写', () => {
    for (const n of ['dev', 'DEV', 'Dev', 'dev_phone', 'DEV_Phone', 'dev.phone', 'dev phone', 'Dev:mac', 'dev_', 'dev@x', 'devéx' /* 非 ASCII 同样消毒成 _ */]) {
      expect(isReservedMcpServerName(n), n).toBe(true)
    }
    for (const n of ['devtools', 'dev-tools', 'my_dev', 'device', 'github', '_dev', 'de_v', '']) {
      expect(isReservedMcpServerName(n), n).toBe(false)
    }
    expect(sanitizeMcpServerName('dev.phone x')).toBe('dev_phone_x')
  })

  it('写入只拦新出现的保留名;盘上存量放行(引擎加载时跳过并在状态里报错,不把用户锁在设置外)', () => {
    expect(newReservedMcpNames({ github: {}, 'dev.phone': {} }, { github: {} })).toEqual(['dev.phone'])
    expect(newReservedMcpNames({ dev_old: {}, github: {} }, { dev_old: {} })).toEqual([])
    expect(newReservedMcpNames({ DEV: {} }, undefined)).toEqual(['DEV'])
  })
})
