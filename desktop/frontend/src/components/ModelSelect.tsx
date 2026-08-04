/**
 * 设置页用的紧凑模型选择器:一行显示当前值,点开 = 按 provider 分组的下拉菜单。
 * 与主界面 ModelPill 共用一套菜单样式(.composer-menu),只是往**下**弹(--down 变体)。
 *
 * 适用形状:「一个槽 + 可留空跟随云端默认」—— 辅助 LLM / 图像识别 / 生图模型都是这个形状。
 * 之前它们各自把全部模型平铺成一排按钮,模型一多整页就被撑爆(2026-08-03 用户反馈)。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { zoomOf } from '@lcl/engine'
import { groupModelsByProvider } from './ModelGroupList'
import { registerMessages, useI18n } from '../i18n'
import { isCoarsePointer } from '../touch'
import type { ModelInfo } from '../types'

registerMessages({
  'msel.follow': { zh: '跟随云端默认', en: 'Follow cloud default' },
  'msel.none': { zh: '未选择', en: 'Not selected' },
})

/** 选项多到这个数才给搜索框(少量选项时搜索框只是噪音)。 */
const SEARCH_THRESHOLD = 12
/** 菜单最大高度 + 间距,与 .composer-menu 的 max-height:320 对齐(翻转判定用)。 */
const MENU_MAX = 330

export function ModelSelect({ models, value, onChange, icon, cloudDefaultId, disabled }: {
  models: ModelInfo[]
  /** 空串 = 未选择(跟随云端默认槽)。 */
  value: string
  onChange: (id: string) => void
  icon?: React.ReactNode
  /** admin 的 app 级默认槽 id;有值时空选显示成「跟随云端默认(某模型)」。 */
  cloudDefaultId?: string | null
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  // 下方放不下就往上弹:设置页正文(.settings-body)是滚动容器,不翻的话菜单被裁掉半截。
  // ⚠️ rect/innerHeight 是**视口** px,MENU_MAX 是**未缩放**局部 px —— 比较前必须乘端级 zoom
  //    (同 ModelPill.subFlips 的坑)。
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!open || !el) return
    const r = el.getBoundingClientRect()
    const need = MENU_MAX * zoomOf(el)
    setUp(window.innerHeight - r.bottom < need && r.top > need)
  }, [open])

  useEffect(() => {
    if (!open) { setQuery(''); return }
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const nameOf = (id: string): string => models.find((m) => m.id === id)?.name || id
  const followLabel = cloudDefaultId ? `${t('msel.follow')} · ${nameOf(cloudDefaultId)}` : t('msel.none')
  const label = value ? nameOf(value) : followLabel

  const q = query.trim().toLowerCase()
  const groups = groupModelsByProvider(
    q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : models,
  )
  const pick = (id: string): void => { onChange(id); setOpen(false) }

  return (
    <div ref={wrapRef} className="model-select" data-cmenu>
      <button className={`model-select-btn${open ? ' is-open' : ''}`} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {icon}
        <span className="grow">{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className={`composer-menu ${up ? 'composer-menu--up' : 'composer-menu--down'}`}>
          {models.length >= SEARCH_THRESHOLD && (
            <span className="model-search">
              <Search size={12} />
              {/* 触屏不自动聚焦:软键盘会把浮层挤走,点条目那一下就落空(见 ../touch.ts)。 */}
              <input autoFocus={!isCoarsePointer()} value={query} placeholder={t('model.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
            </span>
          )}
          {/* 留空 = 回到跟随云端默认;没有这一项就只能选、不能撤销。 */}
          <button className={`menu-item${value ? '' : ' active'}`} onClick={() => pick('')}>
            <span className="grow">{followLabel}</span>
            <span className="mi-check">{value ? '' : <Check size={12} />}</span>
          </button>
          {groups.map((g) => (
            <div key={g.provider}>
              <div className="menu-section">{g.provider}</div>
              {g.models.map((m) => (
                <button key={`${m.source}-${m.id}`} className={`menu-item${m.id === value ? ' active' : ''}`} onClick={() => pick(m.id)}>
                  <span className="grow">{m.name}</span>
                  {m.source === 'direct' && <span className="model-group-tag">{t('model.group.direct')}</span>}
                  <span className="mi-check">{m.id === value ? <Check size={12} /> : ''}</span>
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <div className="menu-section">{t('model.empty')}</div>}
        </div>
      )}
    </div>
  )
}
