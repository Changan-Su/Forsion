/**
 * 造物(Creations)Space 的主视图:本机产物的卡片栅格。
 *
 * 数据只有一条来路 —— `window.tangu.productsList()`(主进程扫托管根 + sidecar)。渲染层从不自己拼路径:
 * 每个动作只把**产物 id** 交回主进程,由它回注册表重解目录(见 electron/productsIpc 的信任口径)。
 * 「继续编辑」是唯一的例外,它要把项目根交给 Coding Studio —— 那是同一台机器上刚由主进程给出的 realpath。
 *
 * 栅格复用启动器的 .newtab-grid / .newtab-card(base.css),卡片内部的左对齐排版、徽标与动作行
 * 在 artificial.css 里补齐。种类差异(图标 / 分组名 / 能不能启动)一律查 PRODUCT_KINDS,别在这里写 if。
 */
import { useEffect, useState } from 'react'
import { AppWindow, ArrowUpRight, Blocks, Code2, FolderOpen, MonitorDown, MoreHorizontal, Pencil, RotateCw, Trash2 } from 'lucide-react'
import { getView, setActiveSpace, Skeleton, useSpaceStore, useWorkspace } from '@lcl/engine'
import { askString } from '@amadeus/components/askString'
import type { ProductSummary } from '../../../../shared/products'
import { useApp } from '../../stores/appStore'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { useI18n } from '../../i18n'
import { CapabilityMenu, type CapabilityMenuItem } from '../../components/CapabilityMenu'
import { useProducts } from './productsStore'
import { groupProducts, kindRow, shortcutToast } from './productKinds'
import { formatListTime } from '../../format/time'
import './artificialMessages'
import './artificial.css'

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function ArtificialView() {
  const { t, locale } = useI18n()
  // 数据住模块级缓存(productsStore):切 Space 重建面板时先画上次的栅格,后台再重扫(U-39)。
  const items = useProducts((s) => s.items)
  const status = useProducts((s) => s.status)
  const load = useProducts((s) => s.load)
  // 本次挂载时手里没有栅格 → 第一次 ready 时淡入(有旧栅格就直接画,不做动效)。
  const [fadeIn] = useState(() => useProducts.getState().status !== 'ready')
  const [busy, setBusy] = useState<string | null>(null)
  // 「继续编辑」与空态按钮的去处:Coding Space 没注册(产品档案不点名 / 无本地预览服务器)就不露入口。
  const canEdit = useSpaceStore((s) => s.spaces.some((sp) => sp.id === 'coding')) && !!getView('code-studio')
  // 「5 分钟前」的**基准时刻**得自己走:取自渲染期的 Date.now() 只在重渲染时更新,
  // 而这块栅格常被丢在副屏上开一整天 —— 一小时后它还写着「5 分钟前」。
  const [now, setNow] = useState(() => Date.now())

  // 挂载 + 每次窗口重新聚焦:产物是磁盘上的目录,用户可能刚在工作室里新建、或在访达里删掉。
  useEffect(() => {
    void load()
    const onFocus = (): void => { setNow(Date.now()); void load() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [load])

  // 每分钟推一次基准时刻(相对时间最小的单位就是分钟,再密没有意义)。
  // 文档不可见时空转 —— 后台标签 / 最小化的窗口不必重排,回到前台由上面的 focus 分支立刻补一次。
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 60_000)
    return () => clearInterval(timer)
  }, [])

  const toast = (key: string, vars?: Record<string, unknown>, error = false): void => useApp.getState().toast(t(key, vars), error)

  // ⚠️显式 newTab:主区 openView 默认是「就地导航」,会把栅格这一页原地换成作品。栅格是这个 Space 的家 ——
  // 被换掉之后重启恢复的布局里只剩作品标签、后退历史也没了,回栅格只能靠「＋」(真机截图自查时发现,09-21)。
  const openProduct = (p: ProductSummary): void => { useWorkspace.getState().openView('product', { id: p.id }, 'main', { newTab: true }) }
  const openWindow = (p: ProductSummary): void => { void window.tangu?.openDetached?.([{ type: 'product', params: { id: p.id } }]) }

  /** 切到 Coding Space 再开项目:setActiveSpace 同步换整份布局,同 tick 开项目会与布局应用赛跑(同 deepLinkInstall)。 */
  const continueEditing = (p: ProductSummary): void => {
    setActiveSpace('coding')
    requestAnimationFrame(() => { useCodeStudio.getState().openProject(p.root, p.name) })
  }

  const addShortcut = async (p: ProductSummary): Promise<void> => {
    const make = window.tangu?.productsShortcut
    if (!make) return
    setBusy(p.id)
    try {
      // 第二个参数是**落盘产物命名**:作品名清洗完可能什么都不剩(纯符号 / 纯 emoji),
      // 那时桌面上的文件名用这个兜底 —— 必须跟随当前界面语言,不能让主进程写死一个中文名。
      const { key, error, vars } = shortcutToast(await make(p.id, t('artificial.shortcut.fallbackName')))
      toast(key, vars, error)
    } catch (e) {
      toast('artificial.toast.shortcutFailed', { detail: detail(e) }, true)
    } finally { setBusy(null) }
  }

  const rename = async (p: ProductSummary): Promise<void> => {
    const update = window.tangu?.productsUpdate
    if (!update) return
    // Electron 没有 window.prompt(调用即失败),全仓统一走 askString。
    const next = (await askString(t('artificial.rename.title'), p.name, { label: t('artificial.rename.label') }))?.trim()
    if (!next || next === p.name) return
    setBusy(p.id)
    try {
      await update(p.id, { name: next })
      await load()
    } catch (e) {
      toast('artificial.toast.renameFailed', { detail: detail(e) }, true)
    } finally { setBusy(null) }
  }

  const trash = async (p: ProductSummary): Promise<void> => {
    const remove = window.tangu?.productsTrash
    // 不可逆动作先确认:整个项目文件夹都会走(文案里说清去了系统废纸篓)。
    if (!remove || !window.confirm(t('artificial.trash.confirm', { name: p.name }))) return
    setBusy(p.id)
    try {
      await remove(p.id)
      await load()
    } catch (e) {
      toast('artificial.toast.trashFailed', { detail: detail(e) }, true)
    } finally { setBusy(null) }
  }

  const card = (p: ProductSummary) => {
    const row = kindRow(p.kind)
    const Icon = row.icon
    const disabled = busy === p.id
    // 卡面只留主动作(打开 / 继续编辑);其余收进「⋯」,移到废纸篓排最后并标 danger(U-13)。
    // 菜单项 id = 旧的 data-action 名,台架 / 单测按它迁移。
    const menu: CapabilityMenuItem[] = [
      ...(row.canLaunch && window.tangu?.openDetached ? [{ id: 'open-window', label: t('artificial.action.openWindow'), icon: <AppWindow size={14} />, onSelect: () => openWindow(p) }] : []),
      ...(canEdit ? [{ id: 'edit', label: t('artificial.action.edit'), icon: <Code2 size={14} />, onSelect: () => continueEditing(p) }] : []),
      ...(row.canShortcut && window.tangu?.productsShortcut ? [{ id: 'shortcut', label: t('artificial.action.shortcut'), icon: <MonitorDown size={14} />, onSelect: () => { void addShortcut(p) } }] : []),
      ...(window.tangu?.revealHostPath ? [{ id: 'reveal', label: t('artificial.action.reveal'), icon: <FolderOpen size={14} />, onSelect: () => { void window.tangu?.revealHostPath?.(p.root) } }] : []),
      ...(window.tangu?.productsUpdate ? [{ id: 'rename', label: t('artificial.action.rename'), icon: <Pencil size={14} />, onSelect: () => { void rename(p) } }] : []),
      ...(window.tangu?.productsTrash ? [{ id: 'trash', label: t('artificial.action.trash'), icon: <Trash2 size={14} />, danger: true, onSelect: () => { void trash(p) } }] : []),
    ]
    const mainDisabled = disabled || (!row.canLaunch && !canEdit)
    return (
      <div className="newtab-card art-card" key={p.id} data-artificial-card data-product-id={p.id} data-kind={p.kind}>
        <button
          // 跑不起来又没有编码工作室可去(单品变体)→ 主按钮没有去处,置灰而不是点了没反应。
          className="art-card-main" data-action="open" disabled={mainDisabled}
          aria-label={row.canLaunch ? t('artificial.action.open', { name: p.name }) : `${t('artificial.action.edit')} · ${p.name}`}
          onClick={() => (row.canLaunch ? openProduct(p) : continueEditing(p))}
        >
          <span className="newtab-card-ic"><Icon size={18} /></span>
          <span className="art-card-name" title={p.name}>{p.name}</span>
          {!mainDisabled && <ArrowUpRight size={14} className="art-card-go" aria-hidden />}
        </button>
        <div className="art-card-foot">
          <div className="art-card-meta">
            <span>{formatListTime(p.updatedAt, { now, locale })}</span>
            {p.published && <span className="art-badge" data-badge="published">{t('artificial.badge.published')}</span>}
            {p.kind === 'plugin' && p.devLoad && <span className="art-badge" data-badge="devload">{t('artificial.badge.devLoad')}</span>}
          </div>
          {menu.length > 0 && (
            <CapabilityMenu label={t('artificial.action.more', { name: p.name })} className="icon-btn art-card-more" disabled={disabled} items={menu}>
              <MoreHorizontal size={14} />
            </CapabilityMenu>
          )}
        </div>
      </div>
    )
  }

  const groups = groupProducts(items)
  return (
    <div className="art-root" data-artificial-root>
      <div className="art-inner">
        <div className="art-head">
          <Blocks size={18} />
          <div className="art-titles">
            <div className="art-title">{t('view.artificial')}</div>
            <div className="art-sub">{t('artificial.subtitle')}</div>
          </div>
          <button className="icon-btn" data-action="refresh" title={t('artificial.refresh')} aria-label={t('artificial.refresh')} onClick={() => { void load() }}>
            <RotateCw size={14} />
          </button>
        </div>

        {status === 'loading' && (
          // 骨架自带 150ms 出现延迟:扫盘快时什么都不闪。读屏靠旁边那句 sr-only 状态。
          <div className="art-loading" data-state="loading">
            <Skeleton variant="list" />
            <span className="art-sr-only" role="status">{t('artificial.loading')}</span>
          </div>
        )}
        {status === 'error' && (
          <div className="art-state" role="alert" data-state="error">
            <div className="art-state-title">{t('artificial.loadFailed')}</div>
            <button className="btn sm" data-action="retry" onClick={() => { void load() }}>{t('common.retry')}</button>
          </div>
        )}
        {status === 'ready' && !groups.length && (
          <div className="art-state" data-state="empty">
            <div className="art-state-title">{t('artificial.empty.title')}</div>
            <p>{t('artificial.empty.body')}</p>
            {canEdit && (
              <button className="btn primary sm" data-action="go-coding" onClick={() => setActiveSpace('coding')}>{t('artificial.empty.cta')}</button>
            )}
          </div>
        )}
        {status === 'ready' && groups.length > 0 && (
          <div className={fadeIn ? 'sk-fade-in' : undefined}>
            {groups.map((g) => (
              <div className="newtab-sec" key={g.kind} data-kind-group={g.kind}>
                <div className="newtab-sec-title">{t(kindRow(g.kind).labelKey)}</div>
                <div className="newtab-grid art-grid">{g.items.map(card)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
