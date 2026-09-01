/** 只钉一条:模块级的 `onStructureChange` 订阅**必须还在**。
 *  它是副作用行,没有任何调用方引用它 —— 2026-08-31 那次 mdTaskStore→mdMarkStore 更名就把它整行漏掉了
 *  (typecheck、单测、e2e 全绿,只是改别的笔记时待办/日历不再更新)。用源码断言当保险丝:
 *  运行期测它得先造出 `window.amadeus`,那是比这条线本身还重的台架。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('mdMarkStore 模块级副作用', () => {
  it('结构变更订阅还在(新建/删除/改名别的笔记时也要重拉)', () => {
    const src = readFileSync(new URL('./mdMarkStore.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/amadeus\?\.onStructureChange\?\.\(\(\) => \{ void useMdMarkStore\.getState\(\)\.load\(\) \}\)/)
  })
})
