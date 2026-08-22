import type { ElBox } from './canvasElements'

/** 卡片松手后的最小空气层。它不是命中带，只是保证两张卡不会视觉粘连。 */
export const CARD_CLEARANCE = 18

const overlaps = (a: ElBox, b: ElBox): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

const grow = (b: ElBox, n: number): ElBox => ({ x: b.x - n, y: b.y - n, w: b.w + n * 2, h: b.h + n * 2 })

/**
 * 把一组正在拖动的卡当作刚体，求离松手点最近的无碰撞平移量。
 *
 * 每一对 moving/obstacle 都会在“平移量空间”里形成一个禁入矩形；离这些矩形并集最近的合法点，
 * x/y 必然落在 0 或某条禁入边界上。因此枚举所有边界的笛卡尔积即可得到全局最近解，不需要
 * 逐帧物理模拟，也不会出现两个障碍之间来回弹跳。多选内部的相对位置始终保持不变。
 */
export function resolveCardRepulsion(
  moving: readonly ElBox[],
  obstacles: readonly ElBox[],
  intent: { x: number; y: number } = { x: 0, y: 0 },
  clearance = CARD_CLEARANCE,
): { x: number; y: number } {
  if (!moving.length || !obstacles.length) return { x: 0, y: 0 }
  const blocked = obstacles.map((b) => grow(b, Math.max(0, clearance)))
  const valid = (x: number, y: number): boolean =>
    moving.every((m) => blocked.every((o) => !overlaps({ ...m, x: m.x + x, y: m.y + y }, o)))
  if (valid(0, 0)) return { x: 0, y: 0 }

  const xs = new Set<number>([0])
  const ys = new Set<number>([0])
  for (const m of moving) for (const o of blocked) {
    // floor/ceil 保证最终坐标取整后仍落在空气层之外。
    xs.add(Math.floor(o.x - (m.x + m.w)))
    xs.add(Math.ceil(o.x + o.w - m.x))
    ys.add(Math.floor(o.y - (m.y + m.h)))
    ys.add(Math.ceil(o.y + o.h - m.y))
  }

  const mag = Math.hypot(intent.x, intent.y)
  let best: { x: number; y: number; score: number } | null = null
  for (const x of xs) for (const y of ys) {
    if (!valid(x, y)) continue
    // 主项是最短位移；同距时偏向继续沿拖动方向“滑出去”，避免卡片反弹回手的来路。
    const forward = mag ? (x * intent.x + y * intent.y) / mag : 0
    const diagonal = x !== 0 && y !== 0 ? 0.1 : 0
    const score = x * x + y * y + diagonal - forward * 1e-3
    if (!best || score < best.score) best = { x, y, score }
  }
  return best ? { x: best.x, y: best.y } : { x: 0, y: 0 }
}

