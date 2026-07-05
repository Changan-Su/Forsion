/**
 * 布局持久化(纯函数,无 DOM)。Dockview 的 api.toJSON()/fromJSON() 产/吃的是 JSON blob;
 * 这里只负责把 blob 存取到 Storage,并管理「命名布局」(≈ Obsidian Workspaces 核心插件)。
 * 纯函数 + 注入 Storage → 可在 node 环境 vitest 里做 save↔load 往返断言。
 */

/** 侧栏收起时必须一并持久化的可重建 panel。 */
export interface PersistedPanel {
  type: string
  params: Record<string, unknown>
}

export interface PersistedSidebar {
  visible: boolean
  stash: PersistedPanel[]
}

/** v4 布局信封：Dockview 图 + 引擎自己的侧栏状态。 */
export interface LayoutEnvelopeV4 {
  version: 4
  dockview: unknown
  sidebars: {
    left: PersistedSidebar
    right: PersistedSidebar
  }
}

export type LayoutBlob = LayoutEnvelopeV4

/** 最小存储接口(默认 localStorage;测试可注入内存 stub)。 */
export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// 旧 desktop 的 forsion_tangu_layout 与新注册表布局不兼容 → 用新 key,不迁移旧 blob。
// v2: Phase 1 早期「会话+对话挤同组」坏布局;v3: 旧 blob 无 params.__type(toggle 会读不到类型)→ 提版本重建。
export const LAYOUT_KEY = 'tangu2_layout_v4'
export const LEGACY_LAYOUT_KEY = 'tangu2_layout_v3'
export const NAMED_LAYOUTS_KEY = 'tangu2_named_layouts'

function isPanelList(value: unknown): value is PersistedPanel[] {
  return Array.isArray(value) && value.every((p) => !!p && typeof p === 'object' && typeof (p as PersistedPanel).type === 'string')
}

export function isLayoutEnvelopeV4(value: unknown): value is LayoutEnvelopeV4 {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<LayoutEnvelopeV4>
  return v.version === 4 && !!v.sidebars
    && typeof v.sidebars.left?.visible === 'boolean'
    && typeof v.sidebars.right?.visible === 'boolean'
    && isPanelList(v.sidebars.left?.stash)
    && isPanelList(v.sidebars.right?.stash)
}

/** v3 只有 Dockview JSON；仅左右栏都在时可无损迁移，否则重建默认布局。 */
export function migrateLegacyLayout(value: unknown): LayoutEnvelopeV4 | null {
  if (!value || typeof value !== 'object') return null
  const panels = (value as { panels?: Record<string, { params?: { __loc?: string } }> }).panels
  if (!panels || typeof panels !== 'object') return null
  const locs = new Set(Object.values(panels).map((p) => p?.params?.__loc).filter(Boolean))
  if (!locs.has('left') || !locs.has('right')) return null
  return {
    version: 4,
    dockview: value,
    sidebars: {
      left: { visible: true, stash: [] },
      right: { visible: true, stash: [] },
    },
  }
}

function safeKV(kv?: KV): KV | null {
  if (kv) return kv
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // private mode
  }
}

/** 存当前布局。 */
export function saveLayout(blob: LayoutBlob, kv?: KV): void {
  const store = safeKV(kv)
  if (!store) return
  try {
    store.setItem(LAYOUT_KEY, JSON.stringify(blob))
  } catch {
    /* 配额/私密模式 */
  }
}

/** 取当前布局(无/损坏 → null)。 */
export function loadLayout(kv?: KV): LayoutBlob | null {
  const store = safeKV(kv)
  if (!store) return null
  try {
    const raw = store.getItem(LAYOUT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      return isLayoutEnvelopeV4(parsed) ? parsed : null
    }
    const legacyRaw = store.getItem(LEGACY_LAYOUT_KEY)
    if (!legacyRaw) return null
    const migrated = migrateLegacyLayout(JSON.parse(legacyRaw) as unknown)
    if (migrated) store.setItem(LAYOUT_KEY, JSON.stringify(migrated))
    return migrated
  } catch {
    return null
  }
}

export function clearLayout(kv?: KV): void {
  const store = safeKV(kv)
  store?.removeItem(LAYOUT_KEY)
  store?.removeItem(LEGACY_LAYOUT_KEY)
}

/** 命名布局表。 */
export function listNamedLayouts(kv?: KV): Record<string, LayoutBlob> {
  const store = safeKV(kv)
  if (!store) return {}
  try {
    const raw = store.getItem(NAMED_LAYOUTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const valid: Record<string, LayoutBlob> = {}
    for (const [name, value] of Object.entries(parsed)) {
      const layout = isLayoutEnvelopeV4(value) ? value : migrateLegacyLayout(value)
      if (layout) valid[name] = layout
    }
    return valid
  } catch {
    return {}
  }
}

export function saveNamedLayout(name: string, blob: LayoutBlob, kv?: KV): void {
  const store = safeKV(kv)
  if (!store) return
  const all = listNamedLayouts(store)
  all[name] = blob
  try {
    store.setItem(NAMED_LAYOUTS_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

export function loadNamedLayout(name: string, kv?: KV): LayoutBlob | null {
  const all = listNamedLayouts(kv)
  return name in all ? all[name] : null
}

export function deleteNamedLayout(name: string, kv?: KV): void {
  const store = safeKV(kv)
  if (!store) return
  const all = listNamedLayouts(store)
  if (name in all) {
    delete all[name]
    try {
      store.setItem(NAMED_LAYOUTS_KEY, JSON.stringify(all))
    } catch {
      /* ignore */
    }
  }
}
