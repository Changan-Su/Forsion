import { describe, expect, it } from 'vitest'
import { createSnakeGame, queueSnakeDirection, stepSnake, type SnakeGameState } from './imageGenerationGame'

describe('image generation Snake easter egg', () => {
  it('moves one dot per tick and refuses an immediate reverse', () => {
    const start = createSnakeGame(() => 0)
    const reversed = queueSnakeDirection(start, 'left')
    expect(reversed.queuedDirection).toBe('right')
    expect(stepSnake(reversed, () => 0).body[0]).toEqual({ x: start.body[0].x + 1, y: start.body[0].y })
  })

  it('grows and increments the score after eating a dot', () => {
    const start = createSnakeGame(() => 0)
    const ready: SnakeGameState = { ...start, food: { x: start.body[0].x + 1, y: start.body[0].y } }
    const next = stepSnake(ready, () => 0)
    expect(next.body).toHaveLength(start.body.length + 1)
    expect(next.score).toBe(1)
    expect(next.body).not.toContainEqual(next.food)
  })

  it('accepts a perpendicular turn but only queues one turn per tick', () => {
    const start = createSnakeGame(() => 0)
    const up = queueSnakeDirection(start, 'up')
    const skippedLeft = queueSnakeDirection(up, 'left')
    expect(skippedLeft.queuedDirection).toBe('up')
    expect(stepSnake(skippedLeft, () => 0).body[0]).toEqual({ x: start.body[0].x, y: start.body[0].y - 1 })
  })

  it('wraps through both horizontal edges without ending the game', () => {
    const start = createSnakeGame(() => 0)
    const atRight: SnakeGameState = {
      ...start,
      body: [{ x: 22, y: 8 }, { x: 21, y: 8 }],
      direction: 'right',
      queuedDirection: 'right',
    }
    const throughRight = stepSnake(atRight, () => 0)
    expect(throughRight.alive).toBe(true)
    expect(throughRight.body[0]).toEqual({ x: 0, y: 8 })

    const atLeft: SnakeGameState = {
      ...start,
      body: [{ x: 0, y: 14 }, { x: 1, y: 14 }],
      direction: 'left',
      queuedDirection: 'left',
    }
    expect(stepSnake(atLeft, () => 0).body[0]).toEqual({ x: 22, y: 14 })
  })

  it('still marks a vertical wall collision as game over', () => {
    const start = createSnakeGame(() => 0)
    const atTop: SnakeGameState = {
      ...start,
      body: [{ x: 8, y: 0 }, { x: 8, y: 1 }],
      direction: 'up',
      queuedDirection: 'up',
    }
    expect(stepSnake(atTop, () => 0).alive).toBe(false)
  })
})
