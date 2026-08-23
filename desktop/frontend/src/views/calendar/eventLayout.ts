/**
 * 周/日时间网格里的重叠事件分栏。
 *
 * 先按「首尾相接的重叠簇」分组，再在每簇内把事件放入最早空闲的 lane；
 * 同簇共享 laneCount，避免两条重叠事件仍画成全宽、后渲染者把前一条完全盖住。
 */
export interface TimedLayoutInput {
  key: string
  start: Date
  end: Date | null
}

export interface TimedLayout {
  lane: number
  laneCount: number
  leftPct: number
  widthPct: number
}

const endMs = (ev: TimedLayoutInput): number =>
  ev.end?.getTime() ?? ev.start.getTime() + 60 * 60 * 1000

export function layoutTimedEvents(events: TimedLayoutInput[]): Map<string, TimedLayout> {
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || endMs(a) - endMs(b))
  const out = new Map<string, TimedLayout>()

  for (let begin = 0; begin < sorted.length;) {
    let end = begin + 1
    let clusterEnd = endMs(sorted[begin])
    while (end < sorted.length && sorted[end].start.getTime() < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, endMs(sorted[end]))
      end += 1
    }

    const cluster = sorted.slice(begin, end)
    const laneEnds: number[] = []
    const assigned = cluster.map((ev) => {
      let lane = laneEnds.findIndex((freeAt) => freeAt <= ev.start.getTime())
      if (lane < 0) lane = laneEnds.length
      laneEnds[lane] = endMs(ev)
      return { ev, lane }
    })
    const laneCount = Math.max(1, laneEnds.length)
    for (const { ev, lane } of assigned) {
      out.set(ev.key, {
        lane,
        laneCount,
        leftPct: (lane / laneCount) * 100,
        widthPct: 100 / laneCount,
      })
    }
    begin = end
  }

  return out
}
