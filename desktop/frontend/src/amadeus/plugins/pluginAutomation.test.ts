// ctx.automation.ensure 的纯逻辑(规则 → upsert 入参):前缀 / 路径归一 / where 空数组 / 动作白名单 / 单条坏不拖整批。
// 负对照(已实跑红):去掉 `where.length ? … : undefined` → 「空 where 不带键」红;前缀改裸 key → id 用例红;
// ALLOWED_ACTIONS 放行 agent_run → 拒用例红;normalizeVaultRel 去掉反斜杠替换 → 路径用例红。
import { describe, expect, it } from 'vitest'
import { buildPluginTriggerUpsert, buildPluginTriggerUpserts, isPluginOwnedRule, normalizeVaultRel } from './pluginAutomation'
import type { PluginAutomationRule } from './types'

const rule = (over: Partial<PluginAutomationRule> = {}): PluginAutomationRule => ({
  key: 'out-added',
  desc: '出库新增',
  cond_type: 'db_changed',
  path: '电脑销售ERP/出库记录.db',
  event: 'row_added',
  actions: [{ type: 'db_row_edit', path: '电脑销售ERP/库存表.db', rowFrom: '配件', cells: { 数量: '{{= {target.数量} - {row.出库数量} }}' } }],
  ...over,
})

describe('normalizeVaultRel(与引擎同口径)', () => {
  it('反斜杠→正斜杠、去首尾斜杠、折叠 //、丢 . 段', () => {
    expect(normalizeVaultRel('/电脑销售ERP\\出库记录.db/')).toBe('电脑销售ERP/出库记录.db')
    expect(normalizeVaultRel('a//b/./c.db')).toBe('a/b/c.db')
    expect(normalizeVaultRel('  x.db ')).toBe('x.db')
    expect(normalizeVaultRel('')).toBe('')
  })
})

describe('buildPluginTriggerUpsert', () => {
  it('id = plugin:<pluginId>:<key>,vault 由宿主绑,path 归一,enabled 恒 true', () => {
    const r = buildPluginTriggerUpsert('pc-erp', '/vault', rule({ path: '/电脑销售ERP//出库记录.db' }))
    expect('upsert' in r).toBe(true)
    const u = (r as { upsert: ReturnType<typeof buildPluginTriggerUpsert> extends infer X ? X extends { upsert: infer U } ? U : never : never }).upsert
    expect(u.id).toBe('plugin:pc-erp:out-added')
    expect(u.vault).toBe('/vault')
    expect(u.path).toBe('电脑销售ERP/出库记录.db')
    expect(u.enabled).toBe(true)
    expect(u.cond_type).toBe('db_changed')
    expect('where' in u).toBe(false) // 没给 where 不带键
    expect('cooldown_hours' in u).toBe(false) // 没给冷却不带键(引擎对纯 db 链默认 0)
    expect(u.actions).toEqual([{ type: 'db_row_edit', path: '电脑销售ERP/库存表.db', rowFrom: '配件', cells: { 数量: '{{= {target.数量} - {row.出库数量} }}' } }])
  })

  it("actor 恒为 'plugin-ensure':引擎据此拒绝把**它自己停用的**规则(排空封顶断环 / 配置错误)开回来", () => {
    // 少了这个自报家门,H1 在真实链路上是空转的:引擎收到的 actor 是 undefined,
    // blockedEnable 永远不成立 → 安全闸每次开 App 自动松开、disabledReason 一并被抹掉。
    const r = buildPluginTriggerUpsert('pc-erp', '/vault', rule())
    expect('upsert' in r).toBe(true)
    const u = (r as { upsert: { actor?: string; enabled?: boolean } }).upsert
    expect(u.actor).toBe('plugin-ensure')
    expect(u.enabled).toBe(true)
  })

  it('key 形态闸:只许 [a-z0-9-]+(冒号能伪装成别家规则;大写/空白也拒)', () => {
    for (const bad of ['a:b', 'Out', 'a b', '', 'a_b', '中']) {
      const r = buildPluginTriggerUpsert('p', '/v', rule({ key: bad }))
      expect('error' in r, bad).toBe(true)
    }
  })

  it('actions 白名单:agent_run / tool_call 该条被拒;空 actions 拒;>24 步拒', () => {
    // 断言到错误文案:白名单放行后 agent_run 会改因 path 被拒(另一个错),只断 'error' in 是假绿(实跑抓到过)。
    const ar = buildPluginTriggerUpsert('p', '/v', rule({ actions: [{ type: 'agent_run', agentSlug: 'x', prompt: 'p' } as never] }))
    expect('error' in ar && ar.error).toMatch(/「agent_run」不允许/)
    const tc = buildPluginTriggerUpsert('p', '/v', rule({ actions: [{ type: 'tool_call', tool: 'run_bash', args: {} } as never] }))
    expect('error' in tc && tc.error).toMatch(/「tool_call」不允许/)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ actions: [] }))).toBe(true)
    const many = Array.from({ length: 25 }, () => ({ type: 'notify' as const, title: 't' }))
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ actions: many }))).toBe(true)
    expect('upsert' in buildPluginTriggerUpsert('p', '/v', rule({ actions: many.slice(0, 24) }))).toBe(true)
  })

  it('where:空数组不带键;≤10 条;op 白名单;empty/notempty 不带 value;eq 的 value 成串', () => {
    const empty = buildPluginTriggerUpsert('p', '/v', rule({ where: [] }))
    expect('upsert' in empty && !('where' in empty.upsert)).toBe(true)
    const ok = buildPluginTriggerUpsert('p', '/v', rule({ where: [{ column: '配件', op: 'notempty', value: '残留' }, { column: '状态', op: 'eq', value: '未确认' }] }))
    expect('upsert' in ok && ok.upsert.where).toEqual([{ column: '配件', op: 'notempty' }, { column: '状态', op: 'eq', value: '未确认' }])
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ where: [{ column: 'c', op: 'like' as never }] }))).toBe(true)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ where: Array.from({ length: 11 }, () => ({ column: 'c', op: 'empty' as const })) }))).toBe(true)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ where: [{ column: ' ', op: 'empty' }] }))).toBe(true)
  })

  it('cell_changed 必须 column_id;equals 只在 cell_changed 下带;cooldown 0 原样带、负数拒', () => {
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ event: 'cell_changed' }))).toBe(true)
    const c = buildPluginTriggerUpsert('p', '/v', rule({ event: 'cell_changed', column_id: 'c9', equals: ' 已确认 ', cooldown_hours: 0 }))
    expect('upsert' in c && c.upsert).toMatchObject({ column_id: 'c9', equals: '已确认', cooldown_hours: 0 })
    const rowAdded = buildPluginTriggerUpsert('p', '/v', rule({ equals: 'x' }))
    expect('upsert' in rowAdded && 'equals' in rowAdded.upsert).toBe(false)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ cooldown_hours: -1 }))).toBe(true)
  })

  it('path 闸:非 .db / 含 .. / 动作 path 同样归一;skipIfEmpty 必须是 cells 的键;match.column 非空', () => {
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ path: 'a.md' }))).toBe(true)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ path: '../a.db' }))).toBe(true)
    const a = buildPluginTriggerUpsert('p', '/v', rule({ actions: [{ type: 'db_row_add', path: '/x\\y.db', cells: { 配件: '{{row.CPU}}' }, skipIfEmpty: '配件' }] }))
    expect('upsert' in a && a.upsert.actions).toEqual([{ type: 'db_row_add', path: 'x/y.db', cells: { 配件: '{{row.CPU}}' }, skipIfEmpty: '配件' }])
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ actions: [{ type: 'db_row_add', path: 'x.db', cells: { a: '1' }, skipIfEmpty: 'b' }] }))).toBe(true)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ actions: [{ type: 'db_row_edit', path: 'x.db', cells: { a: '1' }, match: { column: '', value: 'v' } }] }))).toBe(true)
    expect('error' in buildPluginTriggerUpsert('p', '/v', rule({ actions: [{ type: 'db_row_edit', path: 'x.db', cells: {} }] }))).toBe(true)
  })
})

describe('buildPluginTriggerUpserts(整批)', () => {
  it('单条坏规则只进 errors,其余照发;key 重复拒第二条', () => {
    const r = buildPluginTriggerUpserts('pc-erp', '/v', [rule(), rule({ key: 'bad key' }), rule({ key: 'dup' }), rule({ key: 'dup' })])
    expect(r.upserts.map((u) => u.id)).toEqual(['plugin:pc-erp:out-added', 'plugin:pc-erp:dup'])
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]).toMatch(/bad key/)
    expect(r.errors[1]).toMatch(/重复/)
  })
  it('rules 不是数组 → 只有 error', () => {
    expect(buildPluginTriggerUpserts('p', '/v', null as never)).toEqual({ upserts: [], errors: ['rules 必须是数组'] })
  })
})

describe('isPluginOwnedRule', () => {
  it('前缀逐字匹配,pc-erp 认不出 pc-erp2 的规则', () => {
    expect(isPluginOwnedRule('pc-erp', 'plugin:pc-erp:a')).toBe(true)
    expect(isPluginOwnedRule('pc-erp', 'plugin:pc-erp2:a')).toBe(false)
    expect(isPluginOwnedRule('pc-erp', 'w-abc123')).toBe(false)
  })
})
