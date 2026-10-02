/**
 * 插件副作用账本(2026-10-02,对标 Cordis 的「时间维」:注册即带逆)。
 *
 * 一次激活 = 一本账。ctx 上每一次往共享环境里登记东西(订阅、挂载、字体、主题 <style>、编辑器扩展、属性类型、
 * 伴随面、视图表面……)都在登记那一刻把「怎么撤」交到这里;停用 / 重载 / setup 失败时宿主一次关账:
 * 先判死、再杀 facade(ctx.app 变哑),然后按后进先出逐条撤,每条各自 try/catch —— 一条坏了不连累其余。
 * 插件不用维护自己的清理清单,宿主也不再按种类手抄一本本账(09-05 判据:新增两本以上 / 再漏收一次就收成一本 —— 10-01 双双满足)。
 *
 * 关账之后再来的登记(async setup 的 await 之后、残留定时器里)**当场撤销**并拿到空操作,过期续体塞不回幽灵贡献。
 *
 * 边界(Cordis 论文自己也这么写):这里只撤宿主环境里的东西。插件已经写进智库的文件、多维表的行、发出去的请求
 * 是已经发生的事,不追踪也撤不回。
 */

export interface EffectRecord {
  kind: string
  label?: string
}

/** own() 的返回:调用 = 现在就撤并从账上划掉(幂等);forget() = 只划掉不撤(那件东西已经自己收尾了)。 */
export type EffectHandle = (() => void) & { forget(): void }

export interface EffectScope {
  readonly pluginId: string
  /** 同一插件每激活一次加一(排障用:日志里认得出是哪一代)。 */
  readonly generation: number
  alive(): boolean
  own(kind: string, undo: () => void, label?: string): EffectHandle
  /** 同一 key 在这本账上只记一条:按插件整体撤的那几类(编辑器扩展、成就系列、伴随面)登记 N 次也只撤一次。 */
  ownOnce(key: string, undo: () => void): void
  /** 关账。重复调用无事。 */
  close(): void
  /** 账上还挂着的(插件详情页「运行占用」用)。 */
  records(): EffectRecord[]
}

const generations = new Map<string, number>()

const NOOP: EffectHandle = Object.assign(() => {}, { forget: () => {} })

/** killFacade:关账判死之后、逐条撤之前跑 —— 撤副作用的过程中插件代码已经碰不到宿主了。 */
export function createEffectScope(pluginId: string, killFacade?: () => void): EffectScope {
  const generation = (generations.get(pluginId) ?? 0) + 1
  generations.set(pluginId, generation)
  let dead = false
  const entries: Array<{ kind: string; label?: string; undo: () => void }> = []
  const once = new Set<string>()
  const run = (kind: string, undo: () => void): void => {
    try { undo() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" ${kind} cleanup failed`, e) }
  }
  const scope: EffectScope = {
    pluginId,
    generation,
    alive: () => !dead,
    own(kind, undo, label) {
      if (dead) { run(kind, undo); return NOOP }
      const entry = { kind, label, undo }
      entries.push(entry)
      const drop = (): boolean => {
        const i = entries.indexOf(entry)
        if (i < 0) return false
        entries.splice(i, 1)
        return true
      }
      return Object.assign(() => { if (drop()) run(kind, undo) }, { forget: () => { drop() } })
    },
    ownOnce(key, undo) {
      if (dead) { run(key, undo); return }
      if (once.has(key)) return
      once.add(key)
      scope.own(key, undo)
    },
    close() {
      if (dead) return
      dead = true
      if (killFacade) run('facade', killFacade)
      while (entries.length) {
        const e = entries.pop()!
        run(e.kind, e.undo)
      }
    },
    records: () => entries.map((e) => (e.label ? { kind: e.kind, label: e.label } : { kind: e.kind })),
  }
  return scope
}
