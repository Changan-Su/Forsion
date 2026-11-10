import { beforeEach, describe, expect, it, vi } from 'vitest'

const engineFetch = vi.fn()
vi.mock('../../services/engine/targets', () => ({ engineFetch: (...a: unknown[]) => engineFetch(...a), homeTarget: () => ({ key: 'home' }) }))

import { readCalendarSettings, writeCalendarSettings, SETTINGS_ENDPOINT } from './calendarSettingsIo'
import { emptySettingsDoc } from './calendarSettingsDoc'

const res = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? 'not json' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const doc = emptySettingsDoc()

beforeEach(() => engineFetch.mockReset())

describe('读:四态', () => {
  it('200 ok 形状 = 读到了;路径是 /agent/human/Settings/calendar.db,带超时', async () => {
    engineFetch.mockResolvedValue(res(200, { status: 'ok', exists: true, data: doc, version: 'h1' }))
    expect(await readCalendarSettings()).toEqual({ status: 'ok', data: doc, version: 'h1' })
    expect(engineFetch.mock.calls[0][1]).toBe(SETTINGS_ENDPOINT)
    expect(SETTINGS_ENDPOINT).toBe('/agent/human/Settings/calendar.db')
    expect(engineFetch.mock.calls[0][3]?.timeoutMs).toBeGreaterThan(0)
  })
  it('200 missing 形状 = 确认没有', async () => {
    engineFetch.mockResolvedValue(res(200, { status: 'missing', exists: false, version: null }))
    expect(await readCalendarSettings()).toEqual({ status: 'missing' })
  })
  it('422 HUMAN_SETTINGS_CORRUPT = 坏了;422 没带这个码 = 不知道', async () => {
    engineFetch.mockResolvedValueOnce(res(422, { error: 'HUMAN_SETTINGS_CORRUPT', status: 'corrupt' }))
    expect(await readCalendarSettings()).toEqual({ status: 'corrupt' })
    engineFetch.mockResolvedValueOnce(res(422, { error: 'SOMETHING' }))
    expect(await readCalendarSettings()).toEqual({ status: 'unknown' })
  })
  it('接口不存在(旧引擎 / 旧 server 的 404)、401、5xx、抛错、超时 = 不知道,绝不是「没有」', async () => {
    for (const r of [res(404, { error: 'Not found' }), res(404), res(401, {}), res(500, {}), res(503)]) {
      engineFetch.mockResolvedValueOnce(r)
      expect(await readCalendarSettings()).toEqual({ status: 'unknown' })
    }
    engineFetch.mockRejectedValueOnce(new Error('timeout'))
    expect(await readCalendarSettings()).toEqual({ status: 'unknown' })
  })
  it('200 但不是那两种确切形状 = 不知道', async () => {
    const bodies = [
      {}, { ok: true }, { status: 'ok', exists: true, data: doc }, { status: 'ok', exists: true, data: { nope: 1 }, version: 'v' },
      { status: 'ok', exists: true, data: doc, version: '' }, { status: 'missing', exists: false }, { status: 'missing', exists: false, version: 'x' },
      { status: 'missing', version: null }, { exists: false }, ['x'], 'text', null,
    ]
    for (const b of bodies) {
      engineFetch.mockResolvedValueOnce(res(200, b))
      expect(await readCalendarSettings()).toEqual({ status: 'unknown' })
    }
    engineFetch.mockResolvedValueOnce(res(200))
    expect(await readCalendarSettings()).toEqual({ status: 'unknown' })
  })
  it('读到的那份原样返回(不剥掉不认识的顶层字段)', async () => {
    const d = { ...doc, later: { a: 1 } }
    engineFetch.mockResolvedValue(res(200, { status: 'ok', exists: true, data: d, version: 'v' }))
    const r = await readCalendarSettings()
    expect(r.status === 'ok' && (r.data as unknown as { later: unknown }).later).toEqual({ a: 1 })
  })
})

describe('写', () => {
  it('PUT {data, version};200 ok 回新票据;null = 期望不存在', async () => {
    engineFetch.mockResolvedValue(res(200, { ok: true, version: 'h2' }))
    expect(await writeCalendarSettings(doc, null)).toEqual({ status: 'ok', version: 'h2' })
    const [, path, init] = engineFetch.mock.calls[0]
    expect(path).toBe(SETTINGS_ENDPOINT)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ data: doc, version: null })
  })
  it('409 HUMAN_CONFLICT 带回当前那份;corrupt 时不带票据', async () => {
    engineFetch.mockResolvedValueOnce(res(409, { error: 'HUMAN_CONFLICT', status: 'ok', exists: true, data: doc, version: 'h9' }))
    expect(await writeCalendarSettings(doc, 'h1')).toEqual({ status: 'conflict', current: { status: 'ok', data: doc, version: 'h9' } })
    engineFetch.mockResolvedValueOnce(res(409, { error: 'HUMAN_CONFLICT', status: 'missing', exists: false, version: null }))
    expect(await writeCalendarSettings(doc, 'h1')).toEqual({ status: 'conflict', current: { status: 'missing' } })
    engineFetch.mockResolvedValueOnce(res(409, { error: 'HUMAN_CONFLICT', status: 'corrupt', exists: true }))
    expect(await writeCalendarSettings(doc, 'h1')).toEqual({ status: 'conflict', current: { status: 'corrupt' } })
    engineFetch.mockResolvedValueOnce(res(409, { error: 'OTHER' }))
    expect(await writeCalendarSettings(doc, 'h1')).toEqual({ status: 'unknown' })
  })
  it('400 HUMAN_BAD_SETTINGS / 413 HUMAN_SETTINGS_TOO_LARGE = 被拒;413 没这个码(反代)/ 404 / 5xx / 抛错 = 不知道', async () => {
    engineFetch.mockResolvedValueOnce(res(400, { error: 'HUMAN_BAD_SETTINGS' }))
    expect(await writeCalendarSettings(doc, 'v')).toEqual({ status: 'rejected', error: 'HUMAN_BAD_SETTINGS' })
    engineFetch.mockResolvedValueOnce(res(413, { error: 'HUMAN_SETTINGS_TOO_LARGE' }))
    expect(await writeCalendarSettings(doc, 'v')).toEqual({ status: 'rejected', error: 'HUMAN_SETTINGS_TOO_LARGE' })
    for (const r of [res(413), res(404, {}), res(500, {}), res(200, { ok: true })]) {
      engineFetch.mockResolvedValueOnce(r)
      expect(await writeCalendarSettings(doc, 'v')).toEqual({ status: 'unknown' })
    }
    engineFetch.mockRejectedValueOnce(new Error('net'))
    expect(await writeCalendarSettings(doc, 'v')).toEqual({ status: 'unknown' })
  })
})
