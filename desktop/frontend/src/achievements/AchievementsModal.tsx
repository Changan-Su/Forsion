/**
 * 成就面板:左=系列导航(云端 / 本机 / 插件),右=系列进度/铜银金勋章(占位圆徽)+成就列表(标题+条件+领取)。
 * 复用设置/市场的 .settings-page 全屏外壳(已在 base.css 拖窗 no-drag 名单),挂载见 Root.tsx。
 * 云端成就(服务端定义、跟账号走)转成同形的 SeriesDef 复用这套渲染:每条的 event 就是它自己的 id,
 * 进度 / 已领取两张表按 id 现算(进度已登录取服务端的,没登录取本机计数);行尾多一枚奖励、领取走服务端。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Cloud, Gift, Trophy } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { OFFICIAL_SERIES, medalTier, seriesPoints, type MedalTier, type SeriesDef } from './definitions'
import { claimCloudAchievement, cloudClaimable, hasClaimable, refreshCloudAchievements, useAchievements, type Bilingual, type CloudAchievement } from './store'
import './achievements.css'

const TIERS: MedalTier[] = ['bronze', 'silver', 'gold']
const CLOUD_PREFIX = 'cloud:'

function cloudSeriesOf(list: CloudAchievement[], pick: (b?: Bilingual) => string): SeriesDef[] {
  const by = new Map<string, SeriesDef>()
  for (const a of list) {
    const id = CLOUD_PREFIX + a.series
    let s = by.get(id)
    if (!s) { s = { id, icon: Cloud, title: pick(a.seriesTitle) || a.series, medals: { bronze: 1, silver: 1, gold: 1 }, achievements: [] }; by.set(id, s) }
    s.achievements.push({ id: a.id, event: a.id, goal: a.goal, points: a.points, title: pick(a.title) || a.id, desc: pick(a.desc) })
  }
  for (const s of by.values()) {
    const total = Math.max(1, s.achievements.reduce((n, a) => n + a.points, 0)) // 全是 0 点的系列不该一上来就是金牌
    s.medals = { bronze: Math.ceil(total * 0.25), silver: Math.ceil(total * 0.6), gold: total }
  }
  return [...by.values()]
}

export function AchievementsModal({ onClose }: { onClose?: () => void } = {}): React.ReactElement {
  const { t, locale } = useI18n()
  const storeClose = useApp((s) => s.closeAchievements)
  const toast = useApp((s) => s.toast)
  const close = onClose ?? storeClose
  const counters = useAchievements((s) => s.counters)
  const claimed = useAchievements((s) => s.claimed)
  const pluginSeries = useAchievements((s) => s.pluginSeries)
  const claim = useAchievements((s) => s.claim)
  const cloud = useAchievements((s) => s.cloud)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => { void refreshCloudAchievements() }, []) // 打开即对齐一次(别的设备上可能刚领过)

  const pick = (b?: Bilingual): string => (b && (b[locale === 'en' ? 'en' : 'zh'] || b.zh || b.en)) || ''
  const cloudSeries = useMemo(() => cloudSeriesOf(cloud.list, pick), [cloud.list, locale]) // eslint-disable-line react-hooks/exhaustive-deps
  const cloudById = useMemo(() => new Map(cloud.list.map((a) => [a.id, a])), [cloud.list])
  const cloudView = useMemo(() => {
    const prog: Record<string, number> = {}
    const got: Record<string, true> = {}
    for (const a of cloud.list) {
      prog[a.id] = cloud.signedIn ? a.progress : (counters[a.event] || 0)
      if (a.claimed) got[a.id] = true
    }
    return { counters: prog, claimed: got }
  }, [cloud, counters])

  const series: SeriesDef[] = [...cloudSeries, ...OFFICIAL_SERIES, ...pluginSeries.map((x) => x.def)]
  const [activeId, setActiveId] = useState(cloudSeries[0]?.id || 'starter')
  const active = series.find((x) => x.id === activeId) || series[0]
  const isCloud = active.id.startsWith(CLOUD_PREFIX)
  const view = isCloud ? cloudView : { counters, claimed }

  const seriesName = (s: SeriesDef): string => s.title || t(`achievements.s.${s.id}`)
  // 有可领的系列名后挂红点(领完即灭);aria 里另说一句,不靠颜色传意
  const navLabel = (s: SeriesDef): React.ReactNode => (s.id.startsWith(CLOUD_PREFIX)
    ? cloudClaimable(cloud, s.id.slice(CLOUD_PREFIX.length))
    : hasClaimable({ counters, claimed, pluginSeries }, s))
    ? <>{seriesName(s)}<span className="ach-dot" aria-label={t('achievements.claimable')} /></>
    : seriesName(s)
  const navButton = (s: SeriesDef): React.ReactElement => (
    <button key={s.id} className={s.id === active.id ? 'active' : ''} onClick={() => setActiveId(s.id)}>{navLabel(s)}</button>
  )
  const pts = seriesPoints(active, view.claimed)
  const total = active.achievements.reduce((sum, a) => sum + a.points, 0)
  const tier = medalTier(active, pts)
  const nextTier = TIERS.find((tr) => pts < active.medals[tr]) ?? null
  const MedalIcon = active.icon || Trophy // 系列共用徽章 = 系列图标(toast 同款)

  const claimCloud = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    const r = await claimCloudAchievement(id)
    setBusy(null)
    if (!r.ok) toast(t('achievements.claimFailed', { msg: r.detail || String(r.status) }), true)
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label="Achievements navigation">
        <div className="settings-nav-top">
          <button className="settings-back" onClick={close}>
            <ArrowLeft size={15} /> {t('settings.backToApp')}
          </button>
        </div>
        <div className="settings-nav-list">
          {cloudSeries.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-grouphead">{t('achievements.cloudGroup')}</div>
              {cloudSeries.map(navButton)}
            </div>
          )}
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t(cloudSeries.length > 0 ? 'achievements.localGroup' : 'achievements.title')}</div>
            {OFFICIAL_SERIES.map(navButton)}
          </div>
          {pluginSeries.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-grouphead">{t('achievements.pluginGroup')}</div>
              {pluginSeries.map(({ def }) => navButton(def))}
            </div>
          )}
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-main-head">
          <div className="settings-main-title">
            {seriesName(active)}
            {isCloud && <span className="ach-cloud-tag"><Cloud size={12} />{t('achievements.cloudTag')}</span>}
          </div>
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
            {/* 每系列一枚勋章:随已领取点数跨阈值升级 灰→铜→银→金(占位图案=单色奖杯圆徽,后续替换) */}
            <div className={`ach-medal${tier ? '' : ' off'}`} data-tier={tier ?? undefined}
              title={nextTier
                ? `${t(`achievements.medal.${nextTier}`)} · ${t('achievements.pts', { n: active.medals[nextTier] })}`
                : t('achievements.medal.gold')}>
              <MedalIcon />
            </div>
          </div>

          <div className="ach-list">
            {active.achievements.map((a) => {
              const cur = Math.min(view.counters[a.event] || 0, a.goal)
              const done = cur >= a.goal
              const got = !!view.claimed[a.id]
              const Icon = a.icon || Trophy
              const c = isCloud ? cloudById.get(a.id) : undefined
              const reward = c?.reward?.map((r) => pick(r.label) || r.kind).join(' · ')
              const device = c?.claimed?.device
              return (
                <div key={a.id} className={`ach-row${got ? ' claimed' : ''}`}>
                  <Icon />
                  <div className="ach-row-main">
                    <div className="ach-row-title">{a.title || t(`achievements.a.${a.id}.title`)}</div>
                    <div className="ach-row-desc">{a.desc ?? t(`achievements.a.${a.id}.desc`)}</div>
                  </div>
                  {reward && <span className="ach-reward"><Gift size={12} />{reward}</span>}
                  <span className="ach-row-pts">{t('achievements.pts', { n: a.points })}</span>
                  {got
                    ? <>
                        {device && <span className="ach-row-prog">{t('achievements.claimedOn', { device })}</span>}
                        <span className="ach-row-got" title={t('achievements.claimed')}><Check size={15} /></span>
                      </>
                    : c?.expired
                      ? <span className="ach-row-prog">{t('achievements.expired')}</span>
                      : !done
                        ? <span className="ach-row-prog">{cur}/{a.goal}</span>
                        : !c
                          ? <button className="ach-claim" onClick={() => claim(a.id)}>{t('achievements.claim')}</button>
                          : cloud.signedIn
                            ? <button className="ach-claim" disabled={busy === a.id} onClick={() => void claimCloud(a.id)}>{t('achievements.claim')}</button>
                            : <span className="ach-row-prog">{t('achievements.signInToClaim')}</span>}
                </div>
              )
            })}
          </div>
        </div>
      </section>
    </div>
  )
}
