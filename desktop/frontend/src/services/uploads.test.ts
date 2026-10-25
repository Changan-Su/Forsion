import { describe, expect, it } from 'vitest'
import { abandonFailures, cancelUpload, forgetUpload, onBatchSettled, oneSaveAtATime, retryUpload, startUpload, uploadBytesLabel, uploadFraction, useUploads, type UploadJobCtx } from './uploads'

const tick = () => new Promise((r) => setTimeout(r, 0))
/** 一个由测试手动收尾的 job */
function manual() {
  let ctx!: UploadJobCtx
  let resolve!: () => void
  let reject!: (e: Error) => void
  const job = (c: UploadJobCtx) => { ctx = c; return new Promise<void>((res, rej) => { resolve = res; reject = rej }) }
  return { job, get ctx() { return ctx }, done: () => resolve(), fail: (m: string) => reject(new Error(m)) }
}
const entry = (id: string) => useUploads.getState()[id]

describe('upload ledger', () => {
  it('walks reading → uploading → done with progress', async () => {
    const m = manual()
    const id = startUpload('a.xlsx', 1000, m.job)
    expect(entry(id).phase).toBe('reading')
    m.ctx.progress(500)
    expect(uploadFraction(entry(id))).toBe(0.5)
    m.ctx.stage('uploading')
    expect(entry(id)).toMatchObject({ phase: 'uploading', sent: null }) // 传输层报第一个进度之前:转圈
    m.ctx.progress(null)
    expect(uploadFraction(entry(id))).toBeNull() // 报不了字节 → 转圈
    m.done(); await tick()
    expect(entry(id).phase).toBe('done')
    expect(uploadFraction(entry(id))).toBe(1)
    forgetUpload(id)
    expect(entry(id)).toBeUndefined()
  })

  it('fails with the message, retries with the same job and id', async () => {
    let calls = 0
    const id = startUpload('b.pdf', 10, async () => { calls++; if (calls === 1) throw new Error('offline') })
    await tick()
    expect(entry(id)).toMatchObject({ phase: 'failed', error: 'offline' })
    retryUpload(id); await tick()
    expect(entry(id).phase).toBe('done')
    expect(calls).toBe(2)
    forgetUpload(id)
  })

  it('runs at most 3 at once and starts the next when one settles', async () => {
    const ms = [manual(), manual(), manual(), manual()]
    const ids = ms.map((m, i) => startUpload(`f${i}`, 1, m.job))
    expect(ids.map((id) => entry(id).phase)).toEqual(['reading', 'reading', 'reading', 'queued'])
    ms[1].done(); await tick()
    expect(entry(ids[3]).phase).toBe('reading')
    for (const m of [ms[0], ms[2], ms[3]]) m.done()
    await tick()
    ids.forEach(forgetUpload)
  })

  it('cancel aborts the running job, drops the entry, and ignores its late result', async () => {
    const m = manual()
    const id = startUpload('c.zip', 1, m.job)
    const signal = m.ctx.signal
    cancelUpload(id)
    expect(signal.aborted).toBe(true)
    expect(entry(id)).toBeUndefined()
    m.fail('aborted'); await tick()
    expect(entry(id)).toBeUndefined()
  })

  it('onBatchSettled waits for every file, skips removed failures, then clears the ledger', async () => {
    const a = manual(), b = manual()
    const ids = [startUpload('a', 1, a.job), startUpload('b', 1, b.job)]
    const got: string[][] = []
    onBatchSettled(ids, (done) => got.push(done))
    a.done(); await tick()
    b.fail('x'); await tick()
    expect(got).toEqual([]) // b 失败还挂着:等重试或移除
    forgetUpload(ids[1])
    expect(got).toEqual([[ids[0]]])
    expect(entry(ids[0])).toBeUndefined()
  })

  it('abandonFailures drops later failures so the batch still settles', async () => {
    const a = manual(), b = manual()
    const ids = [startUpload('a', 1, a.job), startUpload('b', 1, b.job)]
    const got: string[][] = []
    onBatchSettled(ids, (done) => got.push(done))
    abandonFailures(ids) // 界面没了
    a.done(); await tick()
    b.fail('x'); await tick()
    expect(got).toEqual([[ids[0]]])
  })

  it('oneSaveAtATime runs saves in order, one at a time, and survives a failure', async () => {
    const log: string[] = []
    const step = (n: string, fail = false) => () => new Promise<string>((res, rej) => { log.push(`start ${n}`); setTimeout(() => { log.push(`end ${n}`); fail ? rej(new Error(n)) : res(n) }, 5) })
    const r = await Promise.allSettled([oneSaveAtATime(step('1')), oneSaveAtATime(step('2', true)), oneSaveAtATime(step('3'))])
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })

  it('labels bytes in one unit', () => {
    expect(uploadBytesLabel({ id: 'x', name: 'x', size: 18.2 * 1024 * 1024, phase: 'uploading', sent: 7.9 * 1024 * 1024 })).toBe('7.9 / 18.2 MB')
    expect(uploadBytesLabel({ id: 'x', name: 'x', size: 300 * 1024, phase: 'uploading', sent: null })).toBe('300.0 KB')
  })
})
