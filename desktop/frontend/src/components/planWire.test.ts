/**
 * 计划审阅的 wire 约定不可漂移:引擎按这些**字面量**判「批准 / 自动开始」,
 * 桌面改一个字 = 用户点「批准」被当成打回(静默错向,没有类型能抓)。
 * 故直接读引擎源码核对(同 typecheck 里 sync-command-catalog --check 的做法)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PLAN_APPROVE_AUTO, PLAN_APPROVE_MANUAL, PLAN_REJECT, PLAN_REVISION_MARK, isPlanApproveHead } from './InquiryCard'

const engineSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tangu-agent/src/tools/builtin/interaction.ts'),
  'utf8',
)

describe('plan wire 约定', () => {
  it('三个选项字面量与引擎逐字一致', () => {
    for (const opt of [PLAN_APPROVE_AUTO, PLAN_APPROVE_MANUAL, PLAN_REJECT]) {
      expect(engineSrc, `引擎缺少选项:${opt}`).toContain(`'${opt}'`)
    }
  })

  // 引擎按**逐字命中**判批准与自动开始(不是前缀/子串:否则「批准前先补上回滚方案」这种反对意见
  // 会被当成批准)。所以顺序也是契约:PLAN_OPTIONS[0] 必须正是我们那颗「自动开始」按钮发的串。
  it('引擎选项表的顺序与我们的按钮一一对上', () => {
    const arr = engineSrc.match(/const PLAN_OPTIONS = \[([\s\S]*?)\];/)
    expect(arr, '引擎 PLAN_OPTIONS 数组没找到(重命名了?)').toBeTruthy()
    const opts = [...arr![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(opts[0]).toBe(PLAN_APPROVE_AUTO)
    expect(opts[1]).toBe(PLAN_APPROVE_MANUAL)
    expect(opts[3]).toBe(PLAN_REJECT)
  })

  it('引擎的批准判定是逐字命中,不是前缀/子串', () => {
    expect(engineSrc).toContain('APPROVE_OPTIONS.includes(head)')
    expect(engineSrc).toContain('autoStart: head === PLAN_OPTIONS[0]')
    expect(engineSrc).not.toContain("head.startsWith('批准')") // 退回前缀判 = 反对意见被当批准
  })

  it('修订标记两侧一致(前后各带换行,免得粘住选项文本)', () => {
    expect(PLAN_REVISION_MARK).toBe('\n<<<REVISED_PLAN>>>\n')
    expect(engineSrc).toContain("PLAN_REVISION_MARK = '\\n<<<REVISED_PLAN>>>\\n'")
  })

  it('引擎仍以 kind:plan 下发计划询问(桌面据此配对计划卡)', () => {
    expect(engineSrc).toContain("kind: 'plan'")
  })

  // 卡片上的「已批准 / 已打回」回执必须与引擎判定同规则,否则界面说一套、引擎做一套。
  it('⚠️卡片的批准判定与引擎一致:反对意见不能标成已批准', () => {
    expect(isPlanApproveHead(PLAN_APPROVE_AUTO)).toBe(true)
    expect(isPlanApproveHead(PLAN_APPROVE_MANUAL)).toBe(true)
    expect(isPlanApproveHead('批准')).toBe(true)
    for (const s of ['批准前先补上回滚方案', '批准不了,先说清楚迁移', '不批准', PLAN_REJECT]) {
      expect(isPlanApproveHead(s), s).toBe(false)
    }
  })

  it('自由批准词表两侧一致', () => {
    expect(engineSrc).toContain('(批准|同意|approve|approved|ok|yes|y)')
  })
})
