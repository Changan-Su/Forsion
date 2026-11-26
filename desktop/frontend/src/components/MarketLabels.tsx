/**
 * Who an item comes from and what it needs, as the store page and the chat's store cards show it (2026-11-23,
 * docs/ToBeImproved/商店技能来源方案_2026-11-23 · layout B): the label next to the author (Forsion official / Forsion
 * developer / skills.sh / "{source} · Unreviewed" / Source removed), the count in a card's corner, the requirement next
 * to the type, the collected skill's trust row, facts, adaptation tab and the confirm block for scripts / audit warnings.
 * Light on purpose (no store-page imports): MarketPluginCards renders inside chat messages.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, BadgeCheck, Check, Download, ExternalLink, KeyRound, Loader2, ScanLine, Terminal } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import './marketSourceErrors' // 「来源已移除」等与商店页共用的词条
import './MarketLabels.css'
import { formatDate } from '../format/time'
import { AUDIT_PROVIDERS, type AdaptView, type AuditRisk, type CollectedInfo } from '../../../shared/storeSources'
import { compactCount, type InstallStep, type PublisherLabel } from '../services/marketCollected'
import type { MarketCard } from '../types'

registerMessages({
  'market.pub.official': { zh: 'Forsion 官方', en: 'Forsion official' },
  'market.pub.developer': { zh: 'Forsion 开发者', en: 'Forsion developer' },
  'market.pub.unreviewed': { zh: '{source} · 未审核', en: '{source} · Unreviewed' },
  'market.count.installs': { zh: '{n}次安装 · skills.sh 统计', en: '{n} installs · skills.sh' },
  'market.count.installsLong': { zh: '{n}次安装（skills.sh 统计）', en: '{n} installs (counted by skills.sh)' },
  'market.req.cli': { zh: '需要命令行工具', en: 'Needs a command-line tool' },
  'market.req.apiKey': { zh: '需要 API Key', en: 'Needs an API key' },
  'market.req.cliHint': { zh: '第一次用到时，Tangu 会请你批准安装它要的命令行工具。只在桌面端可用。', en: 'The first time it\'s used, Tangu asks you before installing the command-line tool it needs. Desktop only.' },
  'market.req.apiKeyHint': { zh: '用之前要准备好：{keys}。', en: 'Set this up before using it: {keys}.' },
  'market.req.desktopOnly': { zh: '只在桌面端可用。', en: 'Desktop only.' },
  'market.adapt.written': { zh: '为 {who} 写 · 已适配', en: 'Written for {who} · Adapted' },
  'market.adapt.writtenPlain': { zh: '为 {who} 写', en: 'Written for {who}' },
  'market.adapt.mapped': { zh: '{n} 处写法已对应到 Tangu，没有对应不上的。见左边「适配说明」。', en: 'Mapped to Tangu in {n} places, nothing left over. See "Adaptation" on the left.' },
  'market.adapt.mappedSome': { zh: '{n} 处写法已对应到 Tangu，有 {m} 处 Tangu 不支持。见左边「适配说明」。', en: 'Mapped to Tangu in {n} places; {m} not supported in Tangu. See "Adaptation" on the left.' },
  'market.trust.collected': { zh: 'Forsion 收录 · 未经人工审核', en: 'Collected by Forsion · Not manually reviewed' },
  'market.trust.collectedHint': { zh: 'Forsion 每天从 skills.sh 收录：已核对能下载、能装、Tangu 读得到；内容本身没人逐条看过。', en: 'Forsion collects it from skills.sh every day and checks that it downloads, installs and loads in Tangu. Nobody has reviewed its content line by line.' },
  'market.fact.audit': { zh: '安全审计', en: 'Security audit' },
  'market.fact.license': { zh: '许可', en: 'License' },
  'market.fact.commit': { zh: '锁定提交', en: 'Pinned commit' },
  'market.fact.files': { zh: '文件', en: 'Files' },
  'market.fact.filesNoScripts': { zh: '{n} 个 · 无脚本', en: '{n} in total · no scripts' },
  'market.fact.filesScripts': { zh: '{n} 个 · {s} 个脚本', en: '{n} in total · scripts: {s}' },
  'market.fact.licenseUnknown': { zh: '未声明', en: 'Not stated' },
  'market.fact.overridden': { zh: '人工放行', en: 'Released after review' },
  'market.audit.low': { zh: '低', en: 'low' },
  'market.audit.medium': { zh: '中', en: 'medium' },
  'market.audit.high': { zh: '高', en: 'high' },
  'market.audit.critical': { zh: '严重', en: 'critical' },
  'market.audit.unknown': { zh: '未知', en: 'unknown' },
  'market.audit.listOk': { zh: '{name} 通过', en: '{name} passed' },
  'market.audit.listRisk': { zh: '{name} 评为{level}风险', en: '{name} rated it {level} risk' },
  'market.viewOnSkillsSh': { zh: '在 skills.sh 查看', en: 'View on skills.sh' },
  'market.upstreamDeleted': { zh: '上游已删除', en: 'Removed upstream' },
  'market.upstreamDeletedHint': { zh: '上游仓库或文件夹已删除。装着的照常能用，不再更新。', en: 'The upstream repository or folder is gone. The installed copy keeps working but won\'t be updated.' },
  'market.delisted': { zh: '已不在收录里', en: 'No longer listed' },
  'market.delistedHint': { zh: 'Forsion 的收录里已经没有它了。装着的照常能用，不再更新。', en: 'Forsion no longer lists it. The installed copy keeps working but won\'t be updated.' },
  'market.installWithPrereq': { zh: '安装（连同 1 个前置）', en: 'Install (with 1 prerequisite)' },
  'market.installWithPrereqs': { zh: '安装（连同 {n} 个前置）', en: 'Install (with {n} prerequisites)' },
  'market.prereqInstalling': { zh: '正在装前置 {name}（{n}/{total}）', en: 'Installing prerequisite {name} ({n} of {total})' },
  'market.prereqMissing': { zh: '有前置技能不在收录里，没有一起装：{list}', en: 'Some prerequisites aren\'t collected and weren\'t installed: {list}' },
  'market.confirm.scripts': { zh: '这个技能带 {n} 个脚本', en: 'This skill comes with {n} scripts' },
  'market.confirm.script': { zh: '这个技能带 1 个脚本', en: 'This skill comes with 1 script' },
  'market.confirm.scriptsAll': { zh: '这个技能和它的前置一共带 {n} 个脚本', en: 'This skill and its prerequisites come with {n} scripts' },
  'market.confirm.auditOnly': { zh: '这个技能的安全审计有警告', en: 'This skill\'s security audit has a warning' },
  'market.confirm.collected': { zh: '来自 skills.sh 收录，内容未经人工审核。脚本不会在安装时运行；Tangu 用到时照常经你审批。', en: 'Collected from skills.sh; its content isn\'t manually reviewed. Scripts don\'t run when it\'s installed, and Tangu asks you before running them as usual.' },
  'market.confirm.source': { zh: '来自「{name}」，未经 Forsion 审核。脚本不会在安装时运行；Tangu 用到时照常经你审批。', en: 'From "{name}", not reviewed by Forsion. Scripts don\'t run when it\'s installed, and Tangu asks you before running them as usual.' },
  'market.confirm.audit': { zh: '安全审计：{list}', en: 'Security audit: {list}' },
  'market.confirm.items': { zh: '涉及：{list}', en: 'Includes: {list}' },
  'market.confirm.itemScripts': { zh: '{name}（{n} 个脚本）', en: '{name} ({n} scripts)' },
  'market.confirm.itemAudit': { zh: '{name}（审计有警告）', en: '{name} (audit warning)' },
  'market.confirm.installAnyway': { zh: '仍然安装', en: 'Install anyway' },
  'market.adapt.tab': { zh: '适配说明', en: 'Adaptation' },
  'market.adapt.intro': { zh: '原文是给 {who} 写的。Forsion 收录时读过整个仓库，补了下面这份说明；原文件一个字没改，Tangu 用这个技能时会把说明一起读到。', en: 'It was written for {who}. When collecting it, Forsion read the whole repository and added the notes below. The original files are unchanged, and Tangu reads these notes along with the skill.' },
  'market.adapt.colQuote': { zh: '原文写法 · 行', en: 'Original · line' },
  'market.adapt.colTangu': { zh: '在 Tangu 里', en: 'In Tangu' },
  'market.adapt.colBy': { zh: '依据', en: 'Basis' },
  'market.adapt.byTable': { zh: '对照表', en: 'Mapping table' },
  'market.adapt.byAi': { zh: 'AI · 已核对原文', en: 'AI · checked against the original' },
  'market.adapt.a.use-skill': { zh: '用 use_skill 读 {target}', en: 'Loads {target} with use_skill' },
  'market.adapt.a.delegate': { zh: '用 delegate 开子任务', en: 'Runs a sub-task with delegate' },
  'market.adapt.a.ask-user': { zh: '用 ask_user 问你', en: 'Asks you with ask_user' },
  'market.adapt.a.todo': { zh: '用 todo_write 记步骤', en: 'Tracks steps with todo_write' },
  'market.adapt.a.skill-dir': { zh: '指向这个技能在 Tangu 里的文件夹', en: 'Points at this skill\'s folder in Tangu' },
  'market.adapt.a.invoke-only-when-named': { zh: '只在你点名它时用，Tangu 不自己挑它', en: 'Used only when you name it; Tangu doesn\'t pick it on its own' },
  'market.adapt.a.tools-hint': { zh: '只当作会用到哪些工具的提示，Tangu 照常请你审批', en: 'A hint about the tools it uses; Tangu still asks for approval as usual' },
  'market.adapt.a.ask-user-run-skill': { zh: '请你先用技能 {target}', en: 'Asks you to run the skill {target} first' },
  'market.adapt.a.context-only': { zh: '只是举例，不用对应', en: 'Just an example; nothing to map' },
  'market.adapt.unsupported': { zh: 'Tangu 不支持（{feature}）', en: 'Not supported in Tangu ({feature})' },
  'market.adapt.featureOther': { zh: '其他', en: 'other' },
  'market.adapt.prereqs': { zh: '一起装的前置（同一仓库，已对过收录表）', en: 'Installed alongside (same repository, checked against the collection)' },
  'market.adapt.setup': { zh: '先用 {name} 配好', en: 'Set up with {name} first' },
  'market.adapt.needs': { zh: '还需要', en: 'Also needs' },
  'market.adapt.note': { zh: 'Tangu 读到的（给模型的，所以是英文）', en: 'What Tangu reads (written for the model, in English)' },
  'market.adapt.unavailable': { zh: '适配说明暂时读不到。安装时会再读一次，读不到就不装。', en: 'The adaptation notes can\'t be read right now. They\'re read again at install, and nothing is installed without them.' },
})

const WHO: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
export const writtenForText = (c: CollectedInfo): string => c.writtenFor.map((w) => WHO[w] ?? w).join(' / ')

/** The label next to the author. */
export function PublisherChip({ label, id }: { label: PublisherLabel; id?: string }) {
  const { t } = useI18n()
  const text = label.kind === 'source' ? t('market.pub.unreviewed', { source: label.title }) : label.kind === 'official' ? t('market.pub.official')
    : label.kind === 'developer' ? t('market.pub.developer') : label.kind === 'builtin' ? 'skills.sh' : t('market.sources.removedBadge')
  return (
    <span className={`mk-pub is-${label.kind}`} data-market-source-badge={id} title={label.kind === 'removed' ? t('market.sources.removedHint') : undefined}>
      {label.kind === 'official' && <BadgeCheck size={12} aria-hidden="true" />}{text}
    </span>
  )
}

/** The count in a card's corner: Forsion downloads, or skills.sh installs (said so in the tooltip). */
export function CountChip({ c, collected }: { c: Pick<MarketCard, 'downloads'>; collected?: boolean }) {
  const { t, locale } = useI18n()
  const n = compactCount(c.downloads, locale)
  const label = collected ? t('market.count.installs', { n }) : t('market.downloads', { n })
  return <span className="mk-count" title={label} aria-label={label}><Download size={11} aria-hidden="true" />{n}</span>
}

/** The one requirement worth saying next to the type (command-line tool > API key > written for Claude Code). */
export function requirementText(c: CollectedInfo | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!c) return ''
  if (c.requirements.cli) return t('market.req.cli')
  if (c.requirements.apiKeys.length) return t('market.req.apiKey')
  if (c.writtenFor.length) return t(c.adapted ? 'market.adapt.written' : 'market.adapt.writtenPlain', { who: writtenForText(c) })
  return ''
}

/** Detail sidebar: what the skill needs and how it was adapted. */
export function CollectedNeeds({ c }: { c: CollectedInfo }) {
  const { t } = useI18n()
  const rows: ReactNode[] = []
  if (c.requirements.cli) rows.push(<div key="cli" className="mk-needs" data-market-needs="cli"><Terminal size={15} aria-hidden="true" /><div><b>{t('market.req.cli')}</b>{t('market.req.cliHint')}</div></div>)
  if (c.requirements.apiKeys.length) rows.push(<div key="key" className="mk-needs" data-market-needs="key"><KeyRound size={15} aria-hidden="true" /><div><b>{t('market.req.apiKey')}</b>{t('market.req.apiKeyHint', { keys: c.requirements.apiKeys.join(t('common.listSep')) })}{c.requirements.desktopOnly && !c.requirements.cli ? ` ${t('market.req.desktopOnly')}` : ''}</div></div>)
  if (c.adapted && c.writtenFor.length) rows.push(<div key="adapt" className="mk-needs" data-market-needs="adapted"><Check size={15} aria-hidden="true" /><div><b>{t('market.adapt.written', { who: writtenForText(c) })}</b>{c.unsupportedCount ? t('market.adapt.mappedSome', { n: c.adaptCount, m: c.unsupportedCount }) : t('market.adapt.mapped', { n: c.adaptCount })}</div></div>)
  return rows.length ? <>{rows}</> : null
}

/** Detail sidebar: the third trust state, between "reviewed for listing" and "not reviewed by Forsion". */
export function CollectedTrustRow() {
  const { t } = useI18n()
  return <div className="mk-trust-row mk-collected-trust" data-store-collected-trust><ScanLine size={17} aria-hidden="true" /><div><strong>{t('market.trust.collected')}</strong><span>{t('market.trust.collectedHint')}</span></div></div>
}

const RISKY = (r: AuditRisk) => r === 'medium' || r === 'high' || r === 'critical'
const PROVIDER: Record<string, string> = { gen: 'Gen', socket: 'Socket', snyk: 'Snyk' }

/** Audit marks: ✓ for safe / low, ⚠ + level for the rest. */
export function AuditMarks({ c }: { c: CollectedInfo }) {
  const { t } = useI18n()
  return (
    <span className="mk-audit">
      {AUDIT_PROVIDERS.map((p) => {
        const r = c.audit[p]
        if (r === 'safe') return <span key={p} className="is-ok"><Check size={12} aria-hidden="true" />{PROVIDER[p]}</span>
        if (r === 'unknown' || r === 'low') return <span key={p} className="is-ok">{r === 'low' ? <Check size={12} aria-hidden="true" /> : null}{PROVIDER[p]}{r === 'unknown' ? ` ${t('market.audit.unknown')}` : ''}</span>
        return <span key={p} className="is-warn"><AlertTriangle size={12} aria-hidden="true" />{PROVIDER[p]} {t(`market.audit.${r}`)}</span>
      })}
      {c.override && <span className="is-ok">{t('market.fact.overridden')}</span>}
    </span>
  )
}

/** One line for the confirm text: "Gen, Socket passed; Snyk rated it medium risk". */
export function auditLine(c: CollectedInfo, t: (k: string, v?: Record<string, string | number>) => string): string {
  const ok = AUDIT_PROVIDERS.filter((p) => c.audit[p] === 'safe' || c.audit[p] === 'low').map((p) => PROVIDER[p])
  const bad = AUDIT_PROVIDERS.filter((p) => RISKY(c.audit[p])).map((p) => t('market.audit.listRisk', { name: PROVIDER[p], level: t(`market.audit.${c.audit[p]}`) }))
  return [ok.length ? t('market.audit.listOk', { name: ok.join(t('common.listSep')) }) : '', ...bad].filter(Boolean).join(t('common.listSep'))
}

/** Detail facts for a collected skill (rendered inside the existing `dl.mk-facts`). */
export function CollectedFacts({ c, commit, updatedAt }: { c: CollectedInfo; commit?: string; updatedAt?: string | null }) {
  const { t } = useI18n()
  const date = updatedAt ? formatDate(new Date(updatedAt)) : ''
  return <>
    <div data-market-audit><dt>{t('market.fact.audit')}</dt><dd><AuditMarks c={c} /></dd></div>
    <div><dt>{t('market.fact.license')}</dt><dd>{c.license || t('market.fact.licenseUnknown')}</dd></div>
    {commit && <div data-market-commit><dt>{t('market.fact.commit')}</dt><dd className="mk-id-value">{commit.slice(0, 7)}{date ? ` · ${date}` : ''}</dd></div>}
    <div><dt>{t('market.fact.files')}</dt><dd>{c.scripts ? t('market.fact.filesScripts', { n: c.files, s: c.scripts }) : t('market.fact.filesNoScripts', { n: c.files })}</dd></div>
  </>
}

export function SkillsShLink({ url }: { url: string }) {
  const { t } = useI18n()
  return <a className="mk-repo-link" href={url} target="_blank" rel="noreferrer" data-market-skillssh-link><ExternalLink size={14} />{t('market.viewOnSkillsSh')}</a>
}

/**
 * Confirm one install that brings scripts or an audit warning (store sidebar and chat card). `found` = counts main
 * reported that the catalog didn't (always shown as the higher number). `sourceTitle` = a user source (no skills.sh text).
 */
export function ScriptsConfirmText({ steps, collected, sourceTitle }: { steps: InstallStep[]; collected?: CollectedInfo; sourceTitle?: string }) {
  const { t } = useI18n()
  const scripts = steps.reduce((n, s) => n + s.scripts, 0)
  const self = steps[steps.length - 1]
  const others = steps.slice(0, -1)
  const title = scripts === 0 ? t('market.confirm.auditOnly')
    : others.some((s) => s.scripts > 0) ? t('market.confirm.scriptsAll', { n: scripts })
      : scripts === 1 ? t('market.confirm.script') : t('market.confirm.scripts', { n: scripts })
  const list = steps.filter((s) => s !== self || others.length).map((s) => s.scripts > 0 ? t('market.confirm.itemScripts', { name: s.name, n: s.scripts }) : s.audit ? t('market.confirm.itemAudit', { name: s.name }) : '').filter(Boolean)
  return (
    <div className="mk-confirm-text">
      <b>{title}</b>
      <span>{sourceTitle ? t('market.confirm.source', { name: sourceTitle }) : t('market.confirm.collected')}</span>
      {collected && <span>{t('market.confirm.audit', { list: auditLine(collected, t) })}</span>}
      {list.length > 1 && <span>{t('market.confirm.items', { list: list.join(t('common.listSep')) })}</span>}
    </div>
  )
}

/** The "Adaptation" tab: what each Claude Code / Codex wording becomes in Tangu, the prerequisites, and the note Tangu reads. */
export function AdaptationTab({ c, adapt, prereqNames }: { c: CollectedInfo; adapt: AdaptView | null | undefined; prereqNames: Record<string, string> }) {
  const { t } = useI18n()
  const who = writtenForText(c) || 'Claude Code'
  if (!adapt) return <div className="mk-adapt" data-market-adapt><div className="mk-detail-section-title">{t('market.adapt.tab')}</div><p>{t('market.adapt.unavailable')}</p></div>
  const name = (id?: string) => (id ? prereqNames[id] || id : '')
  return (
    <div className="mk-adapt" data-market-adapt>
      <div className="mk-detail-section-title">{t('market.adapt.tab')}</div>
      <p>{t('market.adapt.intro', { who })}</p>
      {(adapt.entries.length > 0 || adapt.unsupported.length > 0) && (
        <table>
          <thead><tr><th>{t('market.adapt.colQuote')}</th><th>{t('market.adapt.colTangu')}</th><th>{t('market.adapt.colBy')}</th></tr></thead>
          <tbody>
            {adapt.entries.map((e) => <tr key={`${e.line}-${e.action}`}><td><code>{e.quote}</code> <small>· {e.line}</small></td><td>{t(`market.adapt.a.${e.action}`, { target: name(e.target) })}</td><td className="mk-adapt-by">{e.by === 'ai' ? t('market.adapt.byAi') : t('market.adapt.byTable')}</td></tr>)}
            {adapt.unsupported.map((u) => <tr key={`u-${u.line}`} className="is-unsupported"><td><code>{u.quote}</code> <small>· {u.line}</small></td><td>{t('market.adapt.unsupported', { feature: u.feature === 'hooks' ? 'hooks' : t('market.adapt.featureOther') })}</td><td /></tr>)}
          </tbody>
        </table>
      )}
      {adapt.requires.length > 0 && <>
        <div className="mk-adapt-sub">{t('market.adapt.prereqs')}</div>
        <div className="mk-tags">{adapt.requires.map((r) => <span key={r}><Check size={11} aria-hidden="true" />{name(r)}</span>)}</div>
        {adapt.setup && <p>{t('market.adapt.setup', { name: name(adapt.setup) })}</p>}
      </>}
      {adapt.external.length > 0 && <><div className="mk-adapt-sub">{t('market.adapt.needs')}</div><p>{adapt.external.join(t('common.listSep'))}</p></>}
      <div className="mk-adapt-sub">{t('market.adapt.note')}</div>
      <pre>{adapt.note}</pre>
    </div>
  )
}

/** `scripts` = the per-item text for a skill with scripts / an audit warning (replaces the "doesn't run code" line). */
export function SourceConfirm({ sourceTitle, kindLabel, code, first, busy, onCancel, onConfirm, scripts }: {
  sourceTitle: string; kindLabel: string; code: boolean; first: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void; scripts?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="mk-src-confirm" data-store-source-confirm-install>
      {first && <div>{t('market.sources.confirmFirst', { name: sourceTitle })}</div>}
      {scripts ?? <div>{t(code ? 'market.sources.confirmCode' : 'market.sources.confirmText', { kind: kindLabel })}</div>}
      <div className="mk-src-acts">
        <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>{t('market.sources.cancel')}</button>
        <button type="button" className="btn sm primary" disabled={busy} data-store-source-install onClick={onConfirm}>{busy ? <Loader2 size={13} className="mk-spin" /> : <Download size={13} />}{t(scripts ? 'market.confirm.installAnyway' : 'market.sources.confirmInstall')}</button>
      </div>
    </div>
  )
}
