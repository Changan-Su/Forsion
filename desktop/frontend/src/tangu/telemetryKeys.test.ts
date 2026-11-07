import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_COUNT_KEYS, SETTING_KEYS } from '../../../shared/telemetryKeys'

// Tangu 界面的发送口收的是 string(不引宿主类型,见 telemetry.ts):这里把源码里写死的键逐个对上主进程的白名单,
// 写错 / 契约改名了就红 —— 否则主进程整形时静默丢掉,谁也看不见。
const ROOTS = [join(__dirname), join(__dirname, '../views')]
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : []
})

describe('Tangu 界面的遥测键都在白名单里', () => {
  it('tanguCount / tanguSetting 的字面量键', () => {
    const counts = new Set<string>(), settings = new Set<string>()
    for (const f of ROOTS.flatMap(files)) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/tanguCount\('([^']+)'/g)) counts.add(m[1])
      for (const m of src.matchAll(/tanguSetting\('([^']+)'/g)) settings.add(m[1])
    }
    expect(counts.size).toBeGreaterThan(5)
    expect([...counts].filter((k) => !(APP_COUNT_KEYS as readonly string[]).includes(k))).toEqual([])
    expect([...settings].filter((k) => !Object.hasOwn(SETTING_KEYS, k))).toEqual([])
  })
})
