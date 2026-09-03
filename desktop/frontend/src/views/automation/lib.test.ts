/**
 * 构建器 draft ↔ spec 往返(2026-09-02 立):draft 是白名单重建,不认的字段一进一出即蒸发。
 * 这里用**全字段夹具**钉「一个不丢」—— where / rowFrom / match / skipIfEmpty / cooldown 0。
 * 负对照口径:丢字段的失败形态是静默 undefined,正向断言容易假绿;toSpec 里删掉 rowFrom 那行本测试必须红(已实跑)。
 */
import { describe, expect, it } from 'vitest'
import type { MuseTriggerInfo } from '../../types'
import {
  actionsText, condText, cooldownPayload, hasUnsupportedParts, initialCooldown, stepsFrom, toSpec, triggerToUpsert,
  watchedColumnIds, whereDraftFrom, whereText, whereToUpsert,
} from './lib'

const full: MuseTriggerInfo = {
  id: 'plugin:pc-erp:out-added',
  desc: '出库新增 → 扣库存',
  cond: {
    type: 'db_changed', path: '电脑销售ERP/出库记录.db', vault: '/v', event: 'row_added',
    where: [{ column: '配件', op: 'notempty' }, { column: '状态', op: 'eq', value: '未确认' }],
  },
  cooldownHours: 0,
  lastFiredAt: null,
  enabled: true,
  createdAt: '2026-09-02T00:00:00.000Z',
  actions: [
    { type: 'db_row_edit', path: '电脑销售ERP/库存表.db', rowFrom: '配件', cells: { 数量: '{{= {target.数量} - {row.出库数量} }}' } },
    { type: 'db_row_edit', path: '电脑销售ERP/出库记录.db', match: { column: '订单总表', value: '{{row.id}}' }, cells: { 订单状态: '{{row.订单状态}}' } },
    { type: 'db_row_edit', path: 'x.db', rowId: 'r1', cells: { a: '1' } },
    { type: 'db_row_add', path: '电脑销售ERP/出库记录.db', cells: { 配件: '{{row.CPU}}', 出库数量: '1' }, skipIfEmpty: '配件' },
    { type: 'notify', title: '派单', body: '新装机任务派给 {{row.工作人员}}' },
    { type: 'notify', title: '只有标题' },
  ],
}

describe('构建器 draft ↔ spec 往返', () => {
  it('全字段规则 toSpec(stepsFrom(tr)) 深等于原 actions(where/rowFrom/match/skipIfEmpty 一个不丢)', () => {
    const steps = stepsFrom(full)
    expect(steps).toHaveLength(full.actions!.length)
    expect(toSpec(steps, [])).toEqual(full.actions)
    // 更严:不带 undefined 键(与引擎存盘形状一致;toEqual 会忽略 undefined,这里逐条 JSON 比)
    expect(JSON.stringify(toSpec(steps, []))).toBe(JSON.stringify(full.actions))
  })

  it('draft 里 match 拆成 matchColumn/matchValue,值不 trim(可能是纯模板)', () => {
    const [, m] = stepsFrom(full)
    expect(m.matchColumn).toBe('订单总表')
    expect(m.matchValue).toBe('{{row.id}}')
    const spec = toSpec([{ ...m, matchValue: ' {{row.id}} ' }], [])[0]
    expect(spec).toEqual({ type: 'db_row_edit', path: '电脑销售ERP/出库记录.db', match: { column: '订单总表', value: ' {{row.id}} ' }, cells: { 订单状态: '{{row.订单状态}}' } })
  })

  it('空的可选项不带键(matchColumn 空 → 无 match;skipIfEmpty 空 → 无键)', () => {
    const [edit, , , add] = stepsFrom(full)
    const e = toSpec([{ ...edit, rowFrom: '  ' }], [])[0]
    expect('rowFrom' in e).toBe(false)
    expect('match' in e).toBe(false)
    const a = toSpec([{ ...add, skipIfEmpty: '' }], [])[0]
    expect('skipIfEmpty' in a).toBe(false)
  })

  it('where:cond → 表单行 → upsert 往返;空数组给 undefined;empty/notempty 不带 value;没选列的行丢掉', () => {
    const rows = whereDraftFrom(full.cond)
    expect(rows).toEqual([{ column: '配件', op: 'notempty', value: '' }, { column: '状态', op: 'eq', value: '未确认' }])
    expect(whereToUpsert(rows)).toEqual((full.cond as { where: unknown }).where)
    expect(whereToUpsert([])).toBeUndefined()
    expect(whereToUpsert([{ column: '', op: 'eq', value: 'x' }])).toBeUndefined()
    expect(whereToUpsert([{ column: 'c', op: 'empty', value: '残留值' }])).toEqual([{ column: 'c', op: 'empty' }])
    expect(whereDraftFrom({ type: 'manual' })).toEqual([])
  })

  it('triggerToUpsert 带 where 且 cooldown 0 保留(启停开关是整量 upsert,漏一个就抹一个)', () => {
    const u = triggerToUpsert(full)
    expect(u.where).toEqual((full.cond as { where: unknown }).where)
    expect(u.cooldown_hours).toBe(0)
    expect(u.actions).toBe(full.actions)
    // 没 where 的老规则不带键(带 [] 会让引擎认为 cond 变了)
    const noWhere = { ...full, cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'row_added' } } as MuseTriggerInfo
    expect('where' in triggerToUpsert(noWhere) && triggerToUpsert(noWhere).where !== undefined).toBe(false)
  })

  it('F1 多列监听:triggerToUpsert 原样带回 column_ids(启停开关整量 upsert,漏发即退化成只盯首列);单列不带键', () => {
    const multi = { ...full, cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'cust', columnIds: ['cust', 'st'], equals: '已确认' } } as MuseTriggerInfo
    const u = triggerToUpsert(multi)
    expect(u.column_id).toBe('cust')
    expect(u.column_ids).toEqual(['cust', 'st'])
    expect(u.equals).toBe('已确认')
    // 单列老规则:没有 column_ids 键(发 [] / 多余键都可能让引擎按 JSON 比对认为 cond 变了)
    const one = { ...full, cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'c1' } } as MuseTriggerInfo
    expect(triggerToUpsert(one).column_ids).toBeUndefined()
    expect(triggerToUpsert(full).column_ids).toBeUndefined() // row_added
    // 多列规则不能被锁成只读(columnIds 在已知集里)
    expect(hasUnsupportedParts(multi)).toBe(false)
    // 负对照(实跑过):triggerToUpsert 删掉 column_ids 那行 → u.column_ids 得 undefined → 红
  })

  it('F1 watchedColumnIds:columnIds ∪ columnId 去重保序;非 db_changed 给空', () => {
    expect(watchedColumnIds({ type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'c1' })).toEqual(['c1'])
    expect(watchedColumnIds({ type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'cust', columnIds: ['cust', 'st'] })).toEqual(['cust', 'st'])
    expect(watchedColumnIds({ type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'zz', columnIds: ['cust', 'st'] })).toEqual(['cust', 'st', 'zz'])
    expect(watchedColumnIds({ type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnIds: [' st ', ''] })).toEqual(['st'])
    expect(watchedColumnIds({ type: 'db_changed', path: 'a.db', vault: '/v', event: 'row_added' })).toEqual([])
    expect(watchedColumnIds({ type: 'manual' })).toEqual([])
    expect(watchedColumnIds(undefined)).toEqual([])
  })

  it('冷却三处口径:初值 0 显示 "0";payload 0 放行;timer/manual 不送;非法不送', () => {
    expect(initialCooldown({ cooldownHours: 0 })).toBe('0')
    expect(initialCooldown(undefined)).toBe('24')
    // 新建规则按触发类型给默认:db_changed 起 0(与引擎纯动作链默认一致),别的仍 24;编辑态不看 kind
    expect(initialCooldown(undefined, 'db_changed')).toBe('0')
    expect(initialCooldown(null, 'timer')).toBe('24')
    expect(initialCooldown({ cooldownHours: 24 }, 'db_changed')).toBe('24')
    expect(cooldownPayload('db_changed', '0')).toBe(0)
    expect(cooldownPayload('db_changed', '2.5')).toBe(2.5)
    expect(cooldownPayload('timer', '3')).toBeUndefined()
    expect(cooldownPayload('manual', '0')).toBeUndefined()
    expect(cooldownPayload('event_seen', '')).toBeUndefined()
    expect(cooldownPayload('event_seen', '-1')).toBeUndefined()
  })

  it('hasUnsupportedParts:认识的字段全放行;未知动作字段 / 未知 cond 字段 / 未知 cond 类型 → 只读兜底', () => {
    expect(hasUnsupportedParts(full)).toBe(false)
    expect(hasUnsupportedParts(undefined)).toBe(false)
    expect(hasUnsupportedParts({ ...full, actions: [{ type: 'db_row_edit', path: 'a.db', cells: {}, rowId: undefined } as never] })).toBe(false) // undefined 值不算
    expect(hasUnsupportedParts({ ...full, actions: [{ type: 'db_row_edit', path: 'a.db', cells: {}, upsert: true } as never] })).toBe(true)
    expect(hasUnsupportedParts({ ...full, actions: [{ type: 'webhook', url: 'x' } as never] })).toBe(true)
    expect(hasUnsupportedParts({ ...full, cond: { ...full.cond, debounce: 3 } as never })).toBe(true)
    expect(hasUnsupportedParts({ ...full, cond: { type: 'cron', expr: '* * * * *' } as never })).toBe(true)
    // 现存老规则的 vault/columnId/equals 都在已知集里,不能被锁成只读
    expect(hasUnsupportedParts({ ...full, cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'c1', equals: 'x' } })).toBe(false)
  })

  // 文案桩:key + 变量,便于断言具体插了什么
  const t = (k: string, v?: Record<string, string>): string => (v ? `${k}${JSON.stringify(v)}` : k)

  it('condText:db_changed 带 where 条数尾缀与 cell_changed 的等值;没 where 不带尾缀', () => {
    expect(condText(t, full.cond)).toBe('automation.cond.dbRow{"path":"电脑销售ERP/出库记录.db"} · automation.cond.dbWhereN{"n":"2"}')
    expect(condText(t, { type: 'db_changed', path: 'a.db', vault: '/v', event: 'cell_changed', columnId: 'c', equals: '已确认' }))
      .toBe('automation.cond.dbCell{"path":"a.db"} = 已确认')
    expect(condText(t, { type: 'db_changed', path: 'a.db', vault: '/v', event: 'row_added', where: [] })).toBe('automation.cond.dbRow{"path":"a.db"}')
    expect(condText(t, { type: 'cron' } as never)).toBe('cron') // 未知类型防御回落不破
  })

  it('whereText:四种 op 逐条成文,∧ 拼接;空给空串', () => {
    expect(whereText(t, [{ column: '配件', op: 'notempty' }, { column: '状态', op: 'eq', value: '未确认' }, { column: 'x', op: 'ne', value: '1' }, { column: 'y', op: 'empty' }]))
      .toBe('配件 automation.builder.dbWhereOpNotEmpty ∧ 状态 = 未确认 ∧ x ≠ 1 ∧ y automation.builder.dbWhereOpEmpty')
    expect(whereText(t, undefined)).toBe('')
    expect(whereText(t, [])).toBe('')
  })

  it('actionsText:db_row_edit 带靶行标记(→关联列 / →匹配列),db_row_add 带 skipIfEmpty 标记', () => {
    expect(actionsText(t, [], full)).toBe(
      '✎ 电脑销售ERP/库存表.db →配件 → ✎ 电脑销售ERP/出库记录.db →订单总表 → ✎ x.db → ＋ 电脑销售ERP/出库记录.db (?配件) → automation.step.notify → automation.step.notify',
    )
  })
})
