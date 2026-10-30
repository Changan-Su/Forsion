// 商店装技能时「装给哪些 Agent」(方案 docs/ToBeImproved/插件开发体验方案_2026-10-28/skills.html 选 A)。
// 只装一份在公共技能区;没选的 Agent 写进它的屏蔽表(.disabled-inherited-skills.json),选中的「指定」档 Agent 加进
// enabledSkillIds —— 全是 Agent 技能页现成的两条接口,引擎不动。null = 所有 Agent(缺省,和以前一样)。
import { useEffect, useState } from 'react'
import { ChevronDown, Users } from 'lucide-react'
import { CapabilityMenu, type CapabilityMenuItem } from './CapabilityMenu'
import { registerMessages, translate, useI18n } from '../i18n'
import { listAgents, listSkillCatalog, saveAgentDef, setSkillCatalogEntryDisabled } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { useApp } from '../stores/appStore'
import type { NormalAgentDef } from '../../../../tangu-agent/src/contracts/clientTypes'
import './marketSkillAgents.css'

registerMessages({
  'market.skillAgents.for': { zh: '装给', en: 'For' },
  'market.skillAgents.all': { zh: '所有 Agent', en: 'All agents' },
  'market.skillAgents.count': { zh: '{count} 个 Agent', en: '{count} agents' },
  'market.skillAgents.menu': { zh: '给哪些 Agent 用', en: 'Which agents get it' },
  'market.skillAgents.hint': { zh: '只装一份；没选的 Agent 看不到它。之后在 Agent 详情 → 技能 里改。', en: 'One shared copy; agents you leave out don’t see it. Change it later in the agent’s Skills.' },
  'market.skillAgents.auto': { zh: '自动', en: 'Auto' },
  'market.skillAgents.selected': { zh: '指定', en: 'Selected' },
  'market.skillAgents.off': { zh: '技能：关', en: 'Skills off' },
  'market.skillAgents.applyFailed': { zh: '已安装，但没能按选择分给 Agent：{e}。可以到 Agent 详情 → 技能 里调整。', en: 'Installed, but it could not be limited to the agents you picked: {e}. Adjust it in the agent’s Skills.' },
})

export type SkillAgentChoice = string[] | null
type Mode = 'auto' | 'selected' | 'off'
/** 同 AgentSkillsPanel:未配置 = 自动;空名单 = 关;有名单 = 指定。 */
export const skillMode = (a: Pick<NormalAgentDef, 'enabledSkillIds'>): Mode => a.enabledSkillIds == null ? 'auto' : a.enabledSkillIds.length ? 'selected' : 'off'

/** 只有桌面本机引擎分得了;手机 / 网页(云端 worker 不列本机技能)不出这一行、装完也不分。 */
export const skillAgentsSupported = (): boolean => !!window.tangu?.marketInstall && !window.tangu?.mobile

/** 下拉用的 Agent 名册。商店小窗刚开时 cfg 还是假地址,等连上引擎再拉(同 tanguProbe 的就绪判据)。 */
export function useSkillAgents(enabled: boolean): NormalAgentDef[] {
  const [agents, setAgents] = useState<NormalAgentDef[]>([])
  const ready = useApp((s) => s.cfgLoaded && s.connState === 'ok')
  useEffect(() => {
    if (!enabled || !ready || !skillAgentsSupported()) return
    let alive = true, seq = 0
    const load = () => { const mine = ++seq; void listAgents(homeTarget()).then((list) => { if (alive && mine === seq) setAgents(list) }, () => {}) }
    load()
    window.addEventListener('forsion:agents-changed', load)
    return () => { alive = false; window.removeEventListener('forsion:agents-changed', load) }
  }, [enabled, ready])
  return agents
}

/** 点一行之后的选择:点「所有」= null;从「所有」点掉一个 = 其余可选的;勾满了收回 null;不许点成一个都没有。 */
export function nextSkillAgentChoice(choice: SkillAgentChoice, slug: string | null, eligible: string[]): SkillAgentChoice {
  if (slug === null) return null
  const current = choice ?? eligible
  const next = current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]
  if (!next.length) return choice
  return eligible.every((s) => next.includes(s)) ? null : next
}

export function skillAgentLabel(choice: SkillAgentChoice, agents: NormalAgentDef[]): string {
  if (choice === null) return translate('market.skillAgents.all')
  const names = agents.filter((a) => choice.includes(a.slug)).map((a) => a.name)
  return names.length <= 2 ? names.join(translate('common.listSep')) : translate('market.skillAgents.count', { count: names.length })
}

/** 「装给 所有 Agent ▾」:只有一个能用技能的 Agent 时不出现。 */
export function SkillAgentPicker({ agents, choice, onChange, disabled = false, hint = false }: { agents: NormalAgentDef[]; choice: SkillAgentChoice; onChange(next: SkillAgentChoice): void; disabled?: boolean; hint?: boolean }) {
  const { t } = useI18n()
  const eligible = agents.filter((a) => skillMode(a) !== 'off').map((a) => a.slug)
  if (eligible.length < 2) return null
  const items: CapabilityMenuItem[] = [
    { id: '*', label: t('market.skillAgents.all'), icon: <Users size={14} />, selected: choice === null, onSelect: () => onChange(null) },
    ...agents.map((a) => {
      const mode = skillMode(a)
      return { id: a.slug, label: a.name, icon: <span className="mk-agent-initial" aria-hidden="true">{a.name.slice(0, 1)}</span>, hint: t(`market.skillAgents.${mode}`), disabled: mode === 'off',
        selected: mode !== 'off' && (choice === null || choice.includes(a.slug)), onSelect: () => onChange(nextSkillAgentChoice(choice, a.slug, eligible)) }
    }),
  ]
  const label = skillAgentLabel(choice, agents)
  const menu = <CapabilityMenu multiple label={t('market.skillAgents.menu')} items={items} className="mk-agents-trigger" disabled={disabled}>
    <span>{t('market.skillAgents.for')} {label}</span><ChevronDown size={13} />
  </CapabilityMenu>
  return hint ? <div className="mk-agents-row" data-market-skill-agents>{menu}<p className="mk-agents-hint">{t('market.skillAgents.hint')}</p></div> : menu
}

/** 装完(首次安装才调,更新不动已有分配)按选择写各 Agent。选「所有」时只把它加进「指定」档 Agent 的名单。
 *  名册现拉不用下拉里的快照:下载期间名单 / 档位可能变了,装得比名册加载还快时快照也是空的。 */
let applying: Promise<unknown> = Promise.resolve()
export function applySkillAgentChoice(slug: string, choice: SkillAgentChoice): Promise<void> {
  // ponytail: 同一窗口内串行,免得两次安装各拿旧名单互相覆盖;跨窗口(商店小窗 × 主窗)仍可能撞,要防就得引擎侧追加接口
  const run = applying.then(() => assignSkill(slug, choice))
  applying = run.catch(() => {})
  return run
}

async function assignSkill(slug: string, choice: SkillAgentChoice): Promise<void> {
  const target = homeTarget()
  const agents = await listAgents(target)
  const entry = (await listSkillCatalog(target)).find((e) => e.scope === 'user' && e.slug === slug)
  if (!entry) throw new Error(`skill ${slug} not found`)
  for (const a of agents) {
    const mode = skillMode(a)
    if (mode === 'off') continue
    if (choice !== null && !choice.includes(a.slug)) { await setSkillCatalogEntryDisabled(target, entry.key, true, a.slug); continue }
    // ponytail: 卸载不清屏蔽表(技能没了它就不起作用);重装时在这里把选中的 Agent 上残留的那条清掉
    const own = (await listSkillCatalog(target, a.slug)).find((e) => e.key === entry.key)
    if (own?.disabledForAgent) await setSkillCatalogEntryDisabled(target, entry.key, false, a.slug)
    if (mode === 'selected' && !a.enabledSkillIds!.includes(entry.id)) await saveAgentDef(target, { enabledSkillIds: [...a.enabledSkillIds!, entry.id] }, a.slug)
  }
  window.dispatchEvent(new Event('forsion:agents-changed'))
  window.tangu?.requestMainAction?.('agents-changed')
}
