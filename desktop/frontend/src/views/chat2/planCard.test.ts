/** 计划卡与询问的配对:打回→重交那一环(同一条消息累积两条 plan 询问)。 */
import { describe, it, expect } from 'vitest'
import { pickPlanInquiry } from './EditorialMessage'
import type { InquiryRequest } from '../../types'

const inq = (id: string, status: InquiryRequest['status']): InquiryRequest =>
  ({ inquiryId: id, runId: 'r1', question: 'q', options: [], status, kind: 'plan' })

describe('pickPlanInquiry', () => {
  it('无计划正文 → 不配对(通用卡兜底)', () => {
    expect(pickPlanInquiry({ inquiries: [inq('q1', 'pending')] })).toBeUndefined()
  })

  it('单轮:配上那条', () => {
    expect(pickPlanInquiry({ planProposal: 'p', inquiries: [inq('q1', 'pending')] })?.inquiryId).toBe('q1')
  })

  it('⚠️打回后重交:取**待答**那条,不是已答的第一条', () => {
    const m = { planProposal: '第二版', inquiries: [inq('q1', 'answered'), inq('q2', 'pending')] }
    expect(pickPlanInquiry(m)?.inquiryId).toBe('q2')
  })

  it('全部已答 → 取最后一条(展示最新回执)', () => {
    const m = { planProposal: '第二版', inquiries: [inq('q1', 'answered'), inq('q2', 'answered')] }
    expect(pickPlanInquiry(m)?.inquiryId).toBe('q2')
  })

  it('非计划询问不抢位(ask_user 仍走通用卡)', () => {
    const ask = { inquiryId: 'a1', runId: 'r1', question: 'q', options: [], status: 'pending' as const }
    expect(pickPlanInquiry({ planProposal: 'p', inquiries: [ask] })).toBeUndefined()
  })
})
