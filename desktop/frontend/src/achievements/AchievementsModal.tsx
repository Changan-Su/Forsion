/**
 * 成就面板:左=系列导航(官方+插件),右=系列进度/铜银金勋章(占位圆徽)+成就列表(标题+条件+领取)。
 * 复用设置/市场的 .settings-page 全屏外壳(已在 base.css 拖窗 no-drag 名单),挂载见 Root.tsx。
 */
import React, { useState } from 'react'
import { ArrowLeft, Check, Trophy } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { OFFICIAL_SERIES, medalTier, seriesPoints, type MedalTier, type SeriesDef } from './definitions'
import { useAchievements } from './store'
import './achievements.css'

const TIERS: MedalTier[] = ['bronze', 'silver', 'gold']

export function AchievementsModal(): React.ReactElement {
  const { t } = useI18n()
  const close = useApp((s) => s.closeAchievements)
  const counters = useAchievements((s) => s.counters)
  const claimed = useAchievements((s) => s.claimed)
  const pluginSeries = useAchievements((s) => s.pluginSeries)
  const claim = useAchievements((s) => s.claim)

  const series: SeriesDef[] = [...OFFICIAL_SERIES, ...pluginSeries.map((x) => x.def)]
  const [activeId, setActiveId] = useState(series[0]?.id || 'starter')
  const active = series.find((x) => x.id === activeId) || series[0]

  const seriesName = (s: SeriesDef): string => s.title || t(`achievements.s.${s.id}`)
  const pts = seriesPoints(active, claimed)
  const total = active.achievements.reduce((sum, a) => sum + a.points, 0)
  const tier = medalTier(active, pts)

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label="Achievements navigation">
        <div className="settings-nav-top">
          <button className="settings-back" onClick={close}>
            <ArrowLeft size={15} /> {t('settings.backToApp')}
          </button>
        </div>
        <div className="settings-nav-list">
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('achievements.title')}</div>
            {OFFICIAL_SERIES.map((s) => (
              <button key={s.id} className={s.id === active.id ? 'active' : ''} onClick={() => setActiveId(s.id)}>{seriesName(s)}</button>
            ))}
          </div>
          {pluginSeries.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-grouphead">{t('achievements.pluginGroup')}</div>
              {pluginSeries.map(({ def }) => (
                <button key={def.id} className={def.id === active.id ? 'active' : ''} onClick={() => setActiveId(def.id)}>{seriesName(def)}</button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-main-head">
          <div className="settings-main-title">{seriesName(active)}</div>
        </div>
        <div className="settings-body">
          <div className="ach-serieshead">
            <div className="ach-serieshead-info">
              <div className="ach-serieshead-pts">
                {t('achievements.seriesPts', { n: pts, total })}
                {tier && <span className="ach-tier-tag" data-tier={tier}>{t(`achievements.medal.${tier}`)}</span>}
              </div>
              <div className="ach-progressbar"><i style={{ width: `${total ? Math.round((pts / total) * 100) : 0}%` }} /></div>
            </div>
            {/* 勋章占位:纯 CSS 圆徽,圈内显示阈值点数;正式图案后续替换 */}
            <div className="ach-medals">
              {TIERS.map((tr) => (
                <div key={tr} className={`ach-medal${pts >= active.medals[tr] ? '' : ' off'}`} data-tier={tr}
                  title={`${t(`achievements.medal.${tr}`)} · ${t('achievements.pts', { n: active.medals[tr] })}`}>
                  {active.medals[tr]}
                </div>
              ))}
            </div>
          </div>

          <div className="ach-list">
            {active.achievements.map((a) => {
              const cur = Math.min(counters[a.event] || 0, a.goal)
              const done = cur >= a.goal
              const got = !!claimed[a.id]
              const Icon = a.icon || Trophy
              return (
                <div key={a.id} className={`ach-row${got ? ' claimed' : ''}`}>
                  <Icon />
                  <div className="ach-row-main">
                    <div className="ach-row-title">{a.title || t(`achievements.a.${a.id}.title`)}</div>
                    <div className="ach-row-desc">{a.desc ?? t(`achievements.a.${a.id}.desc`)}</div>
                  </div>
                  <span className="ach-row-pts">{t('achievements.pts', { n: a.points })}</span>
                  {got
                    ? <span className="ach-row-got" title={t('achievements.claimed')}><Check size={15} /></span>
                    : done
                      ? <button className="ach-claim" onClick={() => claim(a.id)}>{t('achievements.claim')}</button>
                      : <span className="ach-row-prog">{cur}/{a.goal}</span>}
                </div>
              )
            })}
          </div>
        </div>
      </section>
    </div>
  )
}
