/**
 * 设置 → Space 页末尾的「Ribbon」一块(设置页规范 v1,2026-11-17):两项原来夹在外观页的「显示与动效」里,
 * 改的却是左边那一条 Space 图标的行为,按「它改的是什么」搬到这里。锚点(ribbon-auto-home / ribbon-recent)与 i18n 键不改名,
 * 旧的设置搜索 / 深链落到这一页。手机上没有 Ribbon 滚动,整块不出(和搬家前一样)。
 * 「最近 Space 个数」是 0–5 的整数:按规范用步进器(原来是 6 格分段),0 = 不显示。
 */
import React, { useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { useI18n } from '../i18n'
import { isRibbonAutoHome, setRibbonAutoHome, useRibbonStore, RIBBON_RECENT_MAX } from '@lcl/engine/ribbonRegistry'
import { SettingsPage, type HostSettingsGroup } from './SettingsPage'

export function RibbonSettings(): React.ReactElement {
  const { t } = useI18n()
  const [autoHome, setAutoHome] = useState<boolean>(isRibbonAutoHome)
  const recent = useRibbonStore((s) => s.recentCount)
  const group: HostSettingsGroup = {
    id: 'ribbon', className: 'settings-ribbon',
    icon: <PanelLeft size={16} />, title: t('settings.ribbon.title'), desc: t('settings.ribbon.description'),
    items: [
      { type: 'switch', id: 'ribbon-auto-home', anchor: 'ribbon-auto-home', title: t('settings.theme.ribbonAutoHome'), desc: t('settings.theme.ribbonAutoHomeHint'),
        value: autoHome, onChange: (on) => { setAutoHome(on); setRibbonAutoHome(on) } },
      { type: 'stepper', id: 'ribbon-recent', anchor: 'ribbon-recent', title: t('settings.theme.ribbonRecent'), desc: t('settings.theme.ribbonRecentHint'),
        value: recent, min: 0, max: RIBBON_RECENT_MAX, step: 1, onChange: (n) => useRibbonStore.getState().setRecentCount(n) },
    ],
  }
  return <SettingsPage host schema={{ groups: [group] }} />
}
