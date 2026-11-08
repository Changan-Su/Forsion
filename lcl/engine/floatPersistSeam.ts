/**
 * 浮层卡 × Space 布局的接缝(2026-11-08,LCL 表面规范第三期收尾;§7「Space 作用域的锚点和拖过的位置跟 Space 布局一起记」)。
 * dockviewStore 存 / 换布局时经它问 workspaceOpen「这个 Space 开着哪些卡」、把布局记着的卡交回去开;workspaceOpen 的卡
 * 开 / 关 / 拖动 / 改参数时经它请 dockviewStore 存一次布局。两边都只认这里,互不 import(workspaceOpen 已经引了工作台 store,
 * 反过来引会成环;单列壳里 dockviewStore 不干活,saver 落空就是 no-op)。
 */
import type { PersistedFloat } from './layoutPersist'

export interface FloatPersistence {
  /** 这个 Space 现在该记进布局的卡:开着的,加上布局里记着、还没开回来的(视图没注册 / 浮层宿主还没挂上)。 */
  collect(space: string): PersistedFloat[]
  /** 布局换上来了(启动还原 / 切 Space / 撤销重置):把它记着的卡开回来。已经开着的不动;开不了的先挂起,等到了再开。 */
  restore(space: string, floats: unknown): void
  /** 用户「恢复默认布局」:收掉这个 Space 的卡(撤销重置走 restore 开回来)。 */
  clear(space: string): void
}

let impl: FloatPersistence | null = null
export function setFloatPersistence(p: FloatPersistence | null): void { impl = p }
export function floatPersistence(): FloatPersistence | null { return impl }

/** 工作台那头:存一次当前布局(自己去抖),以及屏上这份布局是给哪个 Space 摆的(null = 不知道)。 */
export interface FloatLayoutHost { save(): void; owner(): string | null }
let host: FloatLayoutHost | null = null
export function setFloatLayoutHost(h: FloatLayoutHost | null): void { host = h }
/** 卡变了(开 / 关 / 换锚点 / 视图改参数):请工作台存一次布局(它自己去抖)。 */
export function floatLayoutChanged(): void { try { host?.save() } catch (e) { console.error('[lcl] float layout save failed', e) } }
/** 屏上这份布局归哪个 Space。卡属于别的 Space(那个 Space 藏着)时,改的是那个 Space 存着的那份,不是屏上这份。 */
export function floatLayoutOwner(): string | null { try { return host?.owner() ?? null } catch { return null } }
