import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_COUNT_KEYS, MODEL_COUNT_KEYS, QUOTA_PROMPT_ACTIONS, QUOTA_PROMPT_ENTRIES, SETTING_KEYS } from '../../../shared/telemetryKeys'
import type { TanguModelCountKey, TanguQuotaAction, TanguQuotaEntry } from './telemetry'

// Tangu 界面的发送口收的是 string(不引宿主类型,见 telemetry.ts):这里把源码里写死的键逐个对上主进程的白名单,
// 写错 / 契约改名了就红 —— 否则主进程整形时静默丢掉,谁也看不见。
const ROOTS = [join(__dirname), join(__dirname, '../views')]
/** Tangu 界面里不在 tangu/ 与 views/ 下、却也用 tanguQuotaPrompt 的文件(tangu-boundary.json 的 files)。 */
const EXTRA = [join(__dirname, '../components/QuotaAdvisoryBanner.tsx')]
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

describe('Tangu 界面 v3 的遥测键也都在白名单里', () => {
  it('tanguQuotaPrompt* 的字面量入口 / 动作、tanguModelCount 的键', () => {
    const entries = new Set<string>(), actions = new Set<string>(), models = new Set<string>()
    for (const f of [...ROOTS.flatMap(files), ...EXTRA]) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/tanguQuotaPrompt(?:Visible|ShownOnce)?\('([^']+)'/g)) entries.add(m[1])
      for (const m of src.matchAll(/const ENTRY = '([^']+)'/g)) if (/tanguQuotaPrompt/.test(src)) entries.add(m[1])
      for (const m of src.matchAll(/tanguQuotaPrompt\([^,()]+,\s*'([^']+)'\)/g)) actions.add(m[1])
      for (const m of src.matchAll(/tanguModelCount\('([^']+)'/g)) models.add(m[1])
    }
    expect(entries.size).toBeGreaterThanOrEqual(3)
    expect(actions.size).toBeGreaterThanOrEqual(5)
    expect(models.size).toBe(3)
    expect([...entries].filter((k) => !(QUOTA_PROMPT_ENTRIES as readonly string[]).includes(k))).toEqual([])
    expect([...actions].filter((k) => !(QUOTA_PROMPT_ACTIONS as readonly string[]).includes(k))).toEqual([])
    expect([...models].filter((k) => !(MODEL_COUNT_KEYS as readonly string[]).includes(k))).toEqual([])
  })
  it('Tangu 那份类型和宿主白名单逐字一致(双向可赋值)', () => {
    const e: TanguQuotaEntry[] = [...QUOTA_PROMPT_ENTRIES]
    const a: TanguQuotaAction[] = [...QUOTA_PROMPT_ACTIONS]
    const m: TanguModelCountKey[] = [...MODEL_COUNT_KEYS]
    const back: { e: typeof QUOTA_PROMPT_ENTRIES[number][]; a: typeof QUOTA_PROMPT_ACTIONS[number][]; m: typeof MODEL_COUNT_KEYS[number][] } = { e, a, m }
    expect(back.e.length + back.a.length + back.m.length).toBe(QUOTA_PROMPT_ENTRIES.length + QUOTA_PROMPT_ACTIONS.length + MODEL_COUNT_KEYS.length)
  })
})
