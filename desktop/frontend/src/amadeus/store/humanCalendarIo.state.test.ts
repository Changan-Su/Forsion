/** readHumanCal 的三态(2026-11-10 日历来源方案):读到了 / 宿主确认没有 / 没问到。读失败 ≠ 没有。 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let respond: () => Promise<Response> = async () => new Response('{}')
vi.mock('../../services/engine/targets', () => ({
  homeTarget: () => ({ key: 'home' }),
  engineFetch: () => respond(),
}))

const { readHumanCal } = await import('./humanCalendarIo')
const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }))

describe('readHumanCal 三态', () => {
  beforeEach(() => { respond = async () => new Response('{}') })
  it('200 有文件 = ok;200 还没建 = ok(第一次写按新建)', async () => {
    const data = { version: 2, name: 'C', columns: [], rows: [] }
    respond = () => json(200, { status: 'ok', data, version: 'v1', legacy: null })
    expect(await readHumanCal()).toMatchObject({ status: 'ok', version: 'v1' })
    respond = () => json(200, { status: 'missing', legacy: null })
    expect(await readHumanCal()).toMatchObject({ status: 'ok', version: '' })
  })
  it('确认没有:404(老引擎没这条接口 / 引擎不在本机)、403 HUMAN_REMOTE_DENIED', async () => {
    respond = () => json(404, { error: 'HUMAN_LOCAL_ONLY' })
    expect(await readHumanCal()).toEqual({ status: 'missing', reason: 'absent' })
    respond = async () => new Response('Cannot GET /agent/human/CALENDAR.db', { status: 404 })
    expect(await readHumanCal()).toEqual({ status: 'missing', reason: 'absent' })
    respond = () => json(403, { error: 'HUMAN_REMOTE_DENIED' })
    expect(await readHumanCal()).toEqual({ status: 'missing', reason: 'absent' })
  })
  it('不知道:网络错、401、别的 403、5xx、响应解析不了', async () => {
    for (const r of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => json(401, { error: 'UNAUTHORIZED' }),
      () => json(403, { error: 'FORBIDDEN' }),
      () => json(500, { error: 'HUMAN_FAILED' }),
      () => json(503, {}),
      async () => new Response('<html>', { status: 200 }),
      () => json(200, null),
    ]) {
      respond = r
      expect(await readHumanCal()).toEqual({ status: 'missing', reason: 'unknown' })
    }
  })
  it('422 仍是 corrupt', async () => {
    respond = () => json(422, { error: 'HUMAN_CALENDAR_CORRUPT' })
    expect(await readHumanCal()).toMatchObject({ status: 'corrupt' })
  })
})
