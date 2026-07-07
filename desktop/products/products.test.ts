/** 产品档案:默认档案值级锁死 + 结构校验。2026-07-05 产品名正式改 Forsion(appId 刻意保留=Windows 升级链锚点)。 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const load = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, `${id}.json`), 'utf8'))

describe('产品档案', () => {
  it('默认档案 forsion = 现状全家桶(值级锁死)', () => {
    expect(load('forsion')).toEqual({
      id: 'forsion',
      displayName: 'Forsion',
      appId: 'com.forsion.tangu-desktop2',
      productName: 'Forsion',
      artifactPrefix: 'Forsion',
      defaultSpace: 'tangu',
      spaces: ['tangu', 'inbox', 'amadeus', 'calendar', 'coding'],
      agentBackend: true,
      market: true,
    })
  })

  it('amadeus 单品:无 agent 后端/无市场/amadeus + calendar space', () => {
    const p = load('amadeus')
    expect(p.agentBackend).toBe(false)
    expect(p.market).toBe(false)
    expect(p.spaces).toEqual(['amadeus', 'calendar'])
    expect(p.defaultSpace).toBe('amadeus')
  })

  it('全部档案:id=文件名 / defaultSpace ∈ spaces / 打包身份字段齐全', () => {
    for (const f of readdirSync(__dirname).filter((x) => x.endsWith('.json'))) {
      const p = load(f.replace(/\.json$/, ''))
      expect(p.id).toBe(f.replace(/\.json$/, ''))
      expect(p.spaces).toContain(p.defaultSpace)
      for (const k of ['displayName', 'appId', 'productName', 'artifactPrefix'] as const) expect(typeof p[k]).toBe('string')
      for (const k of ['agentBackend', 'market'] as const) expect(typeof p[k]).toBe('boolean')
    }
  })
})
