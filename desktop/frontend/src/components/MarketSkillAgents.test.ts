import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('../services/backendService', () => ({
  listAgents: vi.fn(async () => agents.map((a) => ({ ...a }))),
  listSkillCatalog: vi.fn(async (_t: unknown, agentSlug?: string) => [
    { key: 'user:scan', id: 'local:scan', slug: 'scan', scope: 'user', disabledForAgent: agentSlug === 'aria' },
    { key: 'user:other', id: 'local:other', slug: 'other', scope: 'user' },
  ]),
  setSkillCatalogEntryDisabled: vi.fn(async (_t: unknown, key: string, disabled: boolean, slug?: string) => { calls.push(`${disabled ? 'hide' : 'show'} ${key} ${slug}`) }),
  saveAgentDef: vi.fn(async (_t: unknown, def: { enabledSkillIds?: string[] }, slug?: string) => {
    calls.push(`save ${slug} ${def.enabledSkillIds?.join(',')}`)
    Object.assign(agents.find((a) => a.slug === slug), def)
    return {}
  }),
}))
vi.mock('../services/engine/targets', () => ({ homeTarget: () => ({}) }))
vi.mock('../stores/appStore', () => ({ useApp: () => true }))
vi.stubGlobal('window', new EventTarget())

const { applySkillAgentChoice, nextSkillAgentChoice, skillMode } = await import('./MarketSkillAgents')
const agents = [
  { slug: 'xyra', name: 'Arioso' },
  { slug: 'aria', name: 'Aria' },
  { slug: 'coding', name: 'Coding', enabledSkillIds: ['local:other'] },
  { slug: 'muse', name: 'Muse', enabledSkillIds: [] },
] as any[]
const eligible = ['xyra', 'aria', 'coding']

beforeEach(() => { calls.length = 0; agents[2].enabledSkillIds = ['local:other'] })

describe('skill agent choice', () => {
  it('reads the same three modes as the agent Skills page', () => {
    expect(agents.map(skillMode)).toEqual(['auto', 'auto', 'selected', 'off'])
  })
  it('unticking one from "all" keeps the rest; ticking everything goes back to "all"; never empty', () => {
    expect(nextSkillAgentChoice(null, 'aria', eligible)).toEqual(['xyra', 'coding'])
    expect(nextSkillAgentChoice(['xyra', 'coding'], 'aria', eligible)).toBeNull()
    expect(nextSkillAgentChoice(['xyra'], 'xyra', eligible)).toEqual(['xyra'])
    expect(nextSkillAgentChoice(['xyra'], null, eligible)).toBeNull()
  })
})

describe('applySkillAgentChoice', () => {
  it('hides it from agents left out, adds it to a picked "selected" agent, skips agents with skills off', async () => {
    await applySkillAgentChoice('scan', ['coding'])
    expect(calls).toEqual(['hide user:scan xyra', 'hide user:scan aria', 'save coding local:other,local:scan'])
  })
  it('"all agents" clears a leftover hide and adds it to "selected" agents only', async () => {
    await applySkillAgentChoice('scan', null)
    expect(calls).toEqual(['show user:scan aria', 'save coding local:other,local:scan'])
  })
  it('two installs at once both land in a "selected" agent list', async () => {
    agents[2].enabledSkillIds = ['local:x']
    await Promise.all([applySkillAgentChoice('scan', null), applySkillAgentChoice('other', null)])
    expect(agents[2].enabledSkillIds).toEqual(expect.arrayContaining(['local:x', 'local:scan', 'local:other']))
  })
  it('throws when the installed skill is not in the catalog', async () => {
    await expect(applySkillAgentChoice('missing', null)).rejects.toThrow('missing')
  })
})
