/**
 * 设置页用的紧凑模型选择器:一行显示当前值,点开 = 按 provider 分组的下拉菜单。
 * 与主界面 ModelPill 共用一套菜单样式(.composer-menu),只是往**下**弹(--down 变体)。
 *
 * 适用形状:「一个槽 + 可留空跟随云端默认」—— 辅助 LLM / 图像识别 / 生图模型都是这个形状。
 * 之前它们各自把全部模型平铺成一排按钮,模型一多整页就被撑爆(2026-08-03 用户反馈)。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { followAnchor, zoomOf } from '@lcl/engine'
import { ModelMetadata } from './ModelMetadata'
import { useModelPickerPreferences } from '../modelPickerPreferences'
import { groupModelsByProvider } from './ModelGroupList'
import { registerMessages, useI18n } from '../i18n'
import { isCoarsePointer } from '../touch'
import type { ModelInfo } from '../types'

registerMessages({
  'msel.follow': { zh: '跟随云端默认', en: 'Follow cloud default' },
  'msel.followShort': { zh: '跟随', en: 'Default' },
  'msel.none': { zh: '未选择', en: 'Not selected' },
})

/** 选项多到这个数才给搜索框(少量选项时搜索框只是噪音)。 */
const SEARCH_THRESHOLD = 12

export function ModelSelect({ models, value, onChange, icon, cloudDefaultId, disabled, defaultLabel, ariaLabel, chip, footer }: {
  models: ModelInfo[]
  /** 空串 = 未选择(跟随云端默认槽)。 */
  value: string
  onChange: (id: string) => void
  icon?: React.ReactNode
  /** admin 的 app 级默认槽 id;有值时空选显示成「跟随云端默认(某模型)」。 */
  cloudDefaultId?: string | null
  disabled?: boolean
  defaultLabel?: string
  ariaLabel?: string
  /** 按钮里名字后面的小标签(设置 → 默认模型用它标来源:云端 / 自带 key / 订阅 / 本机)。 */
  chip?: React.ReactNode
  /** 菜单最底下一行(如「在模型库管理…」),点了先收菜单再调。 */
  footer?: { label: string; onClick: () => void }
}) {
  const { t } = useI18n()
  const prefs = useModelPickerPreferences()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 菜单 portal 到 body、贴着按钮由 followAnchor 落位:先往下开,下方放不下翻到上方,两侧都放不下就封顶在空间大的一侧滚
  // (设置页正文 .settings-body 是滚动容器,absolute 的菜单会被它裁掉半截)。量的是菜单真实高度,
  // 搜索筛选后变矮 / 窗口缩放 / 端级 zoom / 滚动都重落。portal 是因为 fixed 留在原处会被带 backdrop-filter / transform
  // 的祖先(玻璃主题的面板)当成包含块,坐标整体错位;点外面关的判定因此同时认按钮这边和菜单。
  useLayoutEffect(() => {
    const menu = menuRef.current, wrap = wrapRef.current
    if (!open || !menu || !btnRef.current || !wrap) return
    menu.style.width = `${wrap.getBoundingClientRect().width / zoomOf(menu)}px` // 与控件同宽(原来 left:0;right:0 拉满)
    return followAnchor(menu, btnRef.current, { gap: 6 })
  }, [open])

  useEffect(() => {
    if (!open) { setQuery(''); return }
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false) }
    // Esc 收起时焦点还给按钮:菜单(含搜索框)一卸掉焦点就落到 body,首启引导里这时按回车会直接「开始使用」(Codex 评审)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const nameOf = (id: string): string => models.find((m) => m.id === id)?.name || id
  const followLabel = cloudDefaultId ? `${defaultLabel || t('msel.follow')} · ${nameOf(cloudDefaultId)}` : defaultLabel || t('msel.none')
  // 按钮里的跟随态:灰字前缀 + 实际调到的模型名(菜单里那一项仍写全「跟随云端默认 · X」)
  const label = value ? nameOf(value) : cloudDefaultId
    ? <><span className="model-select-follow">{defaultLabel || t('msel.followShort')} ·</span> {nameOf(cloudDefaultId)}</>
    : <span className="model-select-follow">{followLabel}</span>

  const q = query.trim().toLowerCase()
  const groups = groupModelsByProvider(
    q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : models, prefs,
  )
  const pick = (id: string): void => { onChange(id); setOpen(false); btnRef.current?.focus() }

  return (
    <div ref={wrapRef} className="model-select" data-cmenu>
      <button ref={btnRef} className={`model-select-btn${open ? ' is-open' : ''}`} aria-label={ariaLabel} aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {icon}
        <span className="grow">{label}</span>
        {chip}
        <ChevronDown size={12} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="composer-menu composer-menu--anchored" data-cmenu>
          {models.length >= SEARCH_THRESHOLD && (
            <span className="model-picker-search">
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
          {groups.map((g, index) => (
            <div key={g.key}>
              {groups[index - 1]?.source !== g.source && <div className="menu-source">{t(g.source === 'forsion' ? 'model.group.forsion' : 'model.group.direct')}</div>}
              {g.provider && <div className="menu-section">{g.provider}</div>}
              {g.models.map((m) => (
                <button key={`${m.source}-${m.id}`} className={`menu-item${m.id === value ? ' active' : ''}`} onClick={() => pick(m.id)}>
                  <span className="grow">{m.name}</span>
                  <ModelMetadata model={m} />
                  <span className="mi-check">{m.id === value ? <Check size={12} /> : ''}</span>
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <div className="menu-section">{t('model.empty')}</div>}
          {footer && <div className="model-select-footer">
            <button className="menu-item" onClick={() => { setOpen(false); footer.onClick() }}><span className="grow">{footer.label}</span><ChevronRight size={12} /></button>
          </div>}
        </div>,
        document.body,
      )}
    </div>
  )
}
