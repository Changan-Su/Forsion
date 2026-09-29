/** P1-K2:引擎活动快照的镜像类型(与 tangu-agent/src/services/remoteActivity.test.ts「快照字段」那条同一组键,改一边必须改另一边)。 */
import { describe, it, expect } from 'vitest'
import { parseActivitySnapshot, type ActivitySnapshot } from './remoteActivity'

const SNAPSHOT_KEYS = ['bootId', 'lock', 'processes', 'runs', 'seq', 'v']
const RUN_KEYS = ['category', 'pendingApprovals', 'pendingInquiries', 'remote', 'runId', 'sessionId', 'startedAt']

describe('ActivitySnapshot 镜像', () => {
  it('与引擎同一组键;宽松解析丢掉畸形行、形状不对回 null', () => {
    const snap: ActivitySnapshot = {
      v: 1, bootId: 'abcd1234', seq: 3, lock: { locked: false, source: null },
      runs: [{ runId: 'r', sessionId: 's', category: 'remote', startedAt: 1, pendingApprovals: 0, pendingInquiries: 0, remote: { via: 'tunnel', marked: true } }],
      processes: [],
    }
    expect(Object.keys(snap).sort()).toEqual(SNAPSHOT_KEYS)
    expect(Object.keys(snap.runs[0]).sort()).toEqual(RUN_KEYS)
    expect(parseActivitySnapshot({ ...snap, runs: [...snap.runs, null, { nope: 1 }] })!.runs).toHaveLength(1)
    for (const bad of [null, {}, { ...snap, v: 2 }, { ...snap, runs: 'x' }, { ...snap, lock: null }]) expect(parseActivitySnapshot(bad)).toBeNull()
  })
})
