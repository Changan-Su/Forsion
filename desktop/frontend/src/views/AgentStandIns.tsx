/**
 * 分身(引擎 agents/standIn.ts,11-09 第一期):在微信、企业微信、插件通道里替本体回话的是挂在本体下的分身 ——
 * 人设跟着本体,记忆 / 日志 / 会话各自从零开始,看不到本体的私聊、human/ 与笔记。
 * 这里两处界面:本体配置页顶部的「分身」一段(哪几组通道换分身、勾给它只读的 Library 文件、AGENT.md 开关、已有的分身),
 * 和名册里挂在本体下面的那几行。设置存在本体上(standInOff / standInLibrary / standInAgentMd),随配置页的「保存配置」一起写。
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n'
import { listAgentLibrary, listStandIns, type AgentLibraryFile } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { tanguDelegatedAdmin as isDelegatedAdmin } from '../tangu/delegatedRole'
import { useApp } from '../stores/appStore'
import { AgentMemoryModal } from '../components/AgentMemoryModal'
import { agentName } from '../agentName'
import type { NormalAgentDef, StandInInfo } from '../../../../tangu-agent/src/contracts/clientTypes'
import { isLibraryMemoryRel } from '../../../../tangu-agent/src/contracts/memoryLayers'
import type { TanguDesktopConfig } from '../types'
import { ProfileGroup } from './profileControls'

type Group = 'im' | 'plugin'

/** 名册 / 配置页共用:按通道收拢。多联系人通道(带 standInPeer)合成一行「通道 · N 位联系人」。 */
export function groupStandIns(rows: StandInInfo[], locale: string): Array<{ key: string; label: string; items: StandInInfo[]; multi: boolean }> {
  const by = new Map<string, StandInInfo[]>()
  for (const r of rows) {
    const key = r.standInChannel || r.slug
    by.set(key, [...(by.get(key) || []), r])
  }
  return [...by.entries()].map(([key, items]) => {
    const n = items[0].channelName
    const label = (n ? (locale === 'en' ? n.en || n.zh : n.zh || n.en) : '') || key
    return { key, label, items, multi: items.some((x) => !!x.standInPeer) }
  })
}

/** 本机全部分身,按本体分好;连上的引擎换了、名册重读了、或引擎改了 Agent(forsion:agents-changed)就重读。旧引擎 / 云端 → 空。
 *  名册在连上引擎之前就挂好了(那时的 homeTarget 还是缺省地址),所以必须跟着 cfg / 名册重读,不能只读一次。 */
export function useStandInsByBody(): Map<string, StandInInfo[]> {
  const [rows, setRows] = useState<StandInInfo[]>([])
  const cfg = useApp((a) => a.cfg)
  const roster = useApp((a) => a.agentDefs)
  useEffect(() => {
    let alive = true
    // 分身是本机通道的事(委托管理员的白名单外,引擎也不收远端写分身字段):这个角色下不读
    const load = (): void => { if (isDelegatedAdmin()) return; void listStandIns(homeTarget()).then((r) => { if (alive) setRows(r) }) }
    load()
    window.addEventListener('forsion:agents-changed', load)
    return () => { alive = false; window.removeEventListener('forsion:agents-changed', load) }
  }, [cfg, roster])
  return useMemo(() => {
    const m = new Map<string, StandInInfo[]>()
    for (const r of rows) m.set(r.standInOf, [...(m.get(r.standInOf) || []), r])
    return m
  }, [rows])
}

/** 名册里挂在本体下的几行:只做标识和跳转(点了打开本体,分身在本体页里管)。 */
export function StandInRosterRows({ rows, onOpen }: { rows: StandInInfo[] | undefined; onOpen: () => void }) {
  const { t, locale } = useI18n()
  if (!rows?.length) return null
  return <>{groupStandIns(rows, locale).map((g) => <div key={g.key} className="agents-roster-row agents-roster-standin" data-standin-group={g.key}>
    <button type="button" className="agents-roster-item agents-roster-sub" onClick={onOpen}>
      <span><strong>{g.label}<em className="agents-roster-off">{t('agentProfile.standIn.tag')}</em></strong>
        <small>{g.multi ? t('agentProfile.standIn.contacts', { n: String(g.items.length) }) : t('agentProfile.standIn.ownMemory')}</small></span>
    </button>
  </div>)}</>
}

/** 本体配置页顶部的「分身」一段。draft / patch 是配置页的草稿(保存按钮统一写)。 */
export function AgentStandInGroup({ agent, draft, patch, cfg }: { agent: NormalAgentDef; draft: NormalAgentDef; patch: (p: Partial<NormalAgentDef>) => void; cfg: TanguDesktopConfig }) {
  const { t, locale } = useI18n()
  const [rows, setRows] = useState<StandInInfo[] | null>(null)
  const [files, setFiles] = useState<AgentLibraryFile[] | null>(null)
  const [viewing, setViewing] = useState<StandInInfo | null>(null)
  useEffect(() => {
    let alive = true
    void listStandIns(homeTarget(), agent.slug).then((r) => { if (alive) setRows(r) })
    void listAgentLibrary(homeTarget(), agent.slug).then((f) => { if (alive) setFiles(f) })
    return () => { alive = false }
  }, [cfg, agent.slug])
  const off = draft.standInOff || []
  const setGroup = (g: Group, on: boolean): void => patch({ standInOff: on ? off.filter((x) => x !== g) : [...new Set([...off, g])] })
  // Library/memory/ 底下是本体的记忆详情(11-09 记忆分层):不列、不算、存盘时也丢掉(引擎读根另外再拒一次)
  const lib = (draft.standInLibrary || []).filter((x) => !isLibraryMemoryRel(x))
  const setFile = (name: string, on: boolean): void => patch({ standInLibrary: on ? [...new Set([...lib, name])] : lib.filter((x) => x !== name) })
  // 勾过但 Library 里已经没有的文件也列出来(能取消);头像不算资料
  const choices = [...new Set([...(files || []).map((f) => f.name).filter((n) => !/^avatar\.(png|jpe?g|gif|webp)$/i.test(n) && !isLibraryMemoryRel(n)), ...lib])]
  return <ProfileGroup title={t('agentProfile.standIn.title')} hint={t('agentProfile.standIn.hint')}>
    <div className="agent-standin" data-standin-section>
      <label className="agent-equipment-item"><input type="checkbox" checked={!off.includes('im')} onChange={(e) => setGroup('im', e.target.checked)} /><span><strong>{t('agentProfile.standIn.im')}</strong><small>{t('agentProfile.standIn.imHint')}</small></span></label>
      <label className="agent-equipment-item"><input type="checkbox" checked={!off.includes('plugin')} onChange={(e) => setGroup('plugin', e.target.checked)} /><span><strong>{t('agentProfile.standIn.plugin')}</strong><small>{t('agentProfile.standIn.pluginHint')}</small></span></label>
      <label className="agent-equipment-item"><input type="checkbox" checked={!!draft.standInAgentMd} onChange={(e) => patch({ standInAgentMd: e.target.checked })} /><span><strong>{t('agentProfile.standIn.agentMd')}</strong><small>{t('agentProfile.standIn.agentMdHint')}</small></span></label>
      <details className="equipment-group agent-standin-files">
        <summary><span>{t('agentProfile.standIn.files')}</span><small>{t('agentProfile.standIn.filesCount', { n: String(lib.length) })}</small></summary>
        <div className="agent-equipment-list">
          {files === null ? <p className="agent-profile-muted">{t('agentProfile.standIn.loading')}</p>
            : choices.length ? choices.map((name) => <label key={name} className="agent-equipment-item"><input type="checkbox" checked={lib.includes(name)} onChange={(e) => setFile(name, e.target.checked)} /><strong>{name}</strong></label>)
            : <p className="agent-profile-muted">{t('agentProfile.standIn.filesEmpty')}</p>}
        </div>
      </details>
      <div className="agent-standin-list">
        <small>{t('agentProfile.standIn.existing')}</small>
        {rows === null ? <p className="agent-profile-muted">{t('agentProfile.standIn.loading')}</p>
          : !rows.length ? <p className="agent-profile-muted">{t('agentProfile.standIn.none')}</p>
          : groupStandIns(rows, locale).map((g) => <div key={g.key} className="agent-standin-row" data-standin-row={g.key}>
            <div className="agent-standin-row-head"><strong>{g.label}</strong>{g.multi && <small>{t('agentProfile.standIn.contacts', { n: String(g.items.length) })}</small>}</div>
            {g.items.map((x) => <div key={x.slug} className="agent-standin-item">
              <span>{g.multi ? t('agentProfile.standIn.contact', { id: (x.standInPeer || '').slice(0, 4) }) : agentName(x)}</span>
              <small>{t('agentProfile.standIn.memoryCount', { n: String(x.memoryEntries) })}</small>
              <button type="button" className="profile-text-action" onClick={() => setViewing(x)}>{t('agentProfile.standIn.view')}<ChevronRight size={12} /></button>
            </div>)}
          </div>)}
      </div>
    </div>
    {viewing && <AgentMemoryModal cfg={cfg} slug={viewing.slug} name={agentName(viewing)} onClose={() => setViewing(null)} />}
  </ProfileGroup>
}
