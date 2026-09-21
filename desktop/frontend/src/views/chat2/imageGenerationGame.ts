/** Pure Snake state used by the image-generation easter egg. */

export const IMAGE_GENERATION_GRID = 23

export type SnakeDirection = 'up' | 'right' | 'down' | 'left'
export interface SnakePoint { x: number; y: number }
export interface SnakeGameState {
  body: SnakePoint[]
  direction: SnakeDirection
  queuedDirection: SnakeDirection
  food: SnakePoint
  score: number
  alive: boolean
}

const DELTA: Record<SnakeDirection, SnakePoint> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

const OPPOSITE: Record<SnakeDirection, SnakeDirection> = {
  up: 'down', right: 'left', down: 'up', left: 'right',
}

const samePoint = (a: SnakePoint, b: SnakePoint): boolean => a.x === b.x && a.y === b.y

function nextFood(body: SnakePoint[], random: () => number): SnakePoint {
  const free: SnakePoint[] = []
  for (let y = 0; y < IMAGE_GENERATION_GRID; y++) {
    for (let x = 0; x < IMAGE_GENERATION_GRID; x++) {
      if (!body.some((part) => part.x === x && part.y === y)) free.push({ x, y })
    }
  }
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))] || { x: 0, y: 0 }
}

export function createSnakeGame(random: () => number = Math.random): SnakeGameState {
  const cy = Math.floor(IMAGE_GENERATION_GRID / 2)
  const cx = Math.floor(IMAGE_GENERATION_GRID / 2) + 2
  const body = Array.from({ length: 5 }, (_, i) => ({ x: cx - i, y: cy }))
  return {
    body,
    direction: 'right',
    queuedDirection: 'right',
    food: nextFood(body, random),
    score: 0,
    alive: true,
  }
}

/** Keep one turn queued per movement tick and reject a direct reverse into the body. */
export function queueSnakeDirection(state: SnakeGameState, direction: SnakeDirection): SnakeGameState {
  if (!state.alive || state.queuedDirection !== state.direction || OPPOSITE[state.direction] === direction) return state
  return { ...state, queuedDirection: direction }
}

export function stepSnake(state: SnakeGameState, random: () => number = Math.random): SnakeGameState {
  if (!state.alive) return state
  const direction = state.queuedDirection
  const delta = DELTA[direction]
  const head = state.body[0]
  const rawX = head.x + delta.x
  // 左右边界是相连的：从任一侧穿出，会在同一行的另一侧继续。
  const next = { x: (rawX + IMAGE_GENERATION_GRID) % IMAGE_GENERATION_GRID, y: head.y + delta.y }
  const ate = samePoint(next, state.food)
  const collisionBody = ate ? state.body : state.body.slice(0, -1)
  const hitWall = next.y < 0 || next.y >= IMAGE_GENERATION_GRID
  const hitSelf = collisionBody.some((part) => samePoint(part, next))
  if (hitWall || hitSelf) return { ...state, direction, queuedDirection: direction, alive: false }

  const body = [next, ...state.body]
  if (!ate) body.pop()
  return {
    body,
    direction,
    queuedDirection: direction,
    food: ate ? nextFood(body, random) : state.food,
    score: state.score + (ate ? 1 : 0),
    alive: true,
  }
}
