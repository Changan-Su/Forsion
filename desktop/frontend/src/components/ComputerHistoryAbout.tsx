import React from 'react'
import type { ComputerHistoryView } from '../../../shared/computerHistory'
import { useI18n } from '../i18n'
import './computerHistoryMessages'
import './computerHistory.css'

/**
 * 「会记录 / 不会记录 / 存储 / 谁能读取 / 权限」五条 + 末尾建议。设置页和首次引导的同意说明画的是同一份,
 * 隐私口径只有这一处:要改措辞改词条(computerHistoryMessages.ts),别在调用方另写一段。
 * @param summary 只画前两条(引导页上的摘要;完整五条在它旁边的「完整说明」里)。
 */
export function ComputerHistoryAbout({ view, summary }: { view: ComputerHistoryView; summary?: boolean }): React.ReactNode {
  const { t } = useI18n()
  const windows = view.state.platform === 'win32'
  return <>
    <dl className="ch-about">
      <div className="ch-about-row"><dt>{t('computerHistory.about.recordedLabel')}</dt><dd>{t(windows ? 'computerHistory.win.recorded' : 'computerHistory.about.recorded')}</dd></div>
      <div className="ch-about-row"><dt>{t('computerHistory.about.neverLabel')}</dt><dd>{t(windows ? 'computerHistory.win.never' : 'computerHistory.about.never')}</dd></div>
      {!summary && <>
        <div className="ch-about-row"><dt>{t('computerHistory.about.storageLabel')}</dt><dd>{t('computerHistory.about.storage', { path: view.root, days: view.keepDays })}</dd></div>
        <div className="ch-about-row"><dt>{t('computerHistory.about.accessLabel')}</dt><dd>{t('computerHistory.about.access')}</dd></div>
        <div className="ch-about-row"><dt>{t('computerHistory.about.permissionLabel')}</dt><dd>{t(windows ? 'computerHistory.win.permission' : 'computerHistory.about.permission')}</dd></div>
      </>}
    </dl>
    {!summary && <p className="ch-tip">{t('computerHistory.about.tip')}</p>}
  </>
}
