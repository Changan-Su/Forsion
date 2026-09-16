/**
 * 独立团队编辑器(Agent 轨道的持久团队实体;方案 §6.1 / P5c):名称 + 成员(勾选顺序 = 发言顺序,每人一行角色)+ 运行模式缺省档
 * + 轮数 + TEAM.md 正文。保存走 /agent/teams(POST 新建 / PATCH 更新),成功后刷新 store.teams。
 * 与 GroupChatSetup 同一套浮层视觉;v1 不做拖拽排序、不做头像上传(方案 §10)。
 */
import React, { useMemo, useState } from 'react'
import { Users, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import * as api from '../services/backendService'
import type { NormalAgentDef, TeamDef } from '../types'

registerMessages({
  'team.editor.titleNew': { zh: '新建团队', en: 'New team' },
  'team.editor.titleEdit': { zh: '编辑团队', en: 'Edit team' },
  'team.editor.name': { zh: '团队名称', en: 'Team name' },
  'team.editor.namePlaceholder': { zh: '例如:发布小组', en: 'e.g. Release crew' },
  'team.editor.members': { zh: '成员(勾选顺序 = 发言顺序)', en: 'Members (pick order = speaking order)' },
  'team.editor.rolePlaceholder': { zh: '角色 / 分工(可选)', en: 'Role (optional)' },
  'team.editor.mode': { zh: '默认运行模式', en: 'Default run mode' },
  'team.editor.modeMeeting': { zh: '会议:固定发言序 + 投票', en: 'Meeting: fixed order + votes' },
  'team.editor.modeCollab': { zh: '协作:被 @ 者优先,无人点名即停', en: 'Collab: mentioned members go first, stops when nobody is addressed' },
  'team.editor.rounds': { zh: '轮数上限(协作 = 步数 ÷ 成员数)', en: 'Max rounds (collab: steps ÷ members)' },
  'team.editor.doc': { zh: 'TEAM.md(团队约定,模型读取,建议英文)', en: 'TEAM.md (team charter read by the models; English recommended)' },
  'team.editor.docPlaceholder': { zh: '# Team\n## Mission\n## Roles\n## Workflow\n## Protocol', en: '# Team\n## Mission\n## Roles\n## Workflow\n## Protocol' },
  'team.editor.needTwo': { zh: '至少选择 2 名在册成员', en: 'Pick at least 2 members that still exist' },
  'team.editor.missing': { zh: '已不存在', en: 'missing' },
  'team.editor.save': { zh: '保存', en: 'Save' },
  'team.editor.create': { zh: '创建团队', en: 'Create team' },
  'team.editor.cancel': { zh: '取消', en: 'Cancel' },
  'team.editor.saved': { zh: '团队已保存', en: 'Team saved' },
  'team.editor.failed': { zh: '保存失败:{e}', en: 'Save failed: {e}' },
})

export const TeamEditor: React.FC<{
  agents: NormalAgentDef[]
  /** 编辑既有团队;null = 新建。 */
  team: TeamDef | null
  /** 新建时预选的成员(如私聊里「拉起群聊」:当前 Agent 排第一)。 */
  initialMembers?: string[]
  onSaved: (team: TeamDef) => void
  onClose: () => void
}> = ({ agents, team, initialMembers, onSaved, onClose }) => {
  const { t } = useI18n()
  const candidates = useMemo(() => agents.filter((a) => a.createdBy !== 'system'), [agents])
  const candidateSlugs = useMemo(() => new Set(candidates.map((a) => a.slug)), [candidates])
  const [name, setName] = useState(team?.name || '')
  const [members, setMembers] = useState<Array<{ slug: string; role: string }>>(() =>
    team ? team.members.map((m) => ({ ...m })) : (initialMembers || []).filter((s) => candidates.some((a) => a.slug === s)).map((slug) => ({ slug, role: '' })))
  const [mode, setMode] = useState<'meeting' | 'collab'>(team?.mode || 'meeting')
  const [rounds, setRounds] = useState<number>(team?.maxRounds || 7)
  const [doc, setDoc] = useState(team?.doc || '')
  const [busy, setBusy] = useState(false)
  // 只数还在名册里的成员:已删 / 系统 agent 留在成员表里会让运行时整条 run failed(<2 人)。
  const presentCount = members.filter((m) => candidateSlugs.has(m.slug)).length
  const canSave = name.trim().length > 0 && presentCount >= 2 && !busy

  const toggle = (slug: string) =>
    setMembers((prev) => (prev.some((m) => m.slug === slug) ? prev.filter((m) => m.slug !== slug) : [...prev, { slug, role: '' }]))
  const setRole = (slug: string, role: string) => setMembers((prev) => prev.map((m) => (m.slug === slug ? { ...m, role } : m)))

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    const st = useApp.getState()
    try {
      const input = { name: name.trim(), members, mode, maxRounds: Math.max(1, Math.min(30, Math.floor(rounds) || 1)), doc }
      const saved = team ? await api.patchTeam(st.cfg, team.slug, input) : await api.createTeam(st.cfg, input)
      await st.refreshTeams()
      st.toast(t('team.editor.saved'))
      onSaved(saved)
    } catch (e: any) {
      st.toast(t('team.editor.failed', { e: e?.message || String(e) }), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="team-editor" onClick={(e) => e.stopPropagation()} style={{
        width: 520, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', borderRadius: 12,
        background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', boxShadow: 'var(--card-shadow)', padding: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Users size={18} />
          <strong style={{ fontSize: 15, flex: 1 }}>{team ? t('team.editor.titleEdit') : t('team.editor.titleNew')}</strong>
          <button className="icon-btn" onClick={onClose} title={t('team.editor.cancel')}><X size={16} /></button>
        </div>

        <div className="field">
          <label>{t('team.editor.name')}</label>
          <input type="text" value={name} placeholder={t('team.editor.namePlaceholder')} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div className="field">
          <label>{t('team.editor.members')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}>
            {[...candidates, ...members.filter((m) => !candidateSlugs.has(m.slug)).map((m) => ({ slug: m.slug, name: `${m.slug} (${t('team.editor.missing')})` } as NormalAgentDef))].map((a) => {
              const idx = members.findIndex((m) => m.slug === a.slug)
              const on = idx >= 0
              return (
                <div key={a.slug} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 160, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(a.slug)} />
                    {on && <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 14 }}>{idx + 1}</span>}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  </label>
                  {on && (
                    <input type="text" value={members[idx].role} placeholder={t('team.editor.rolePlaceholder')} style={{ flex: 1 }}
                      onChange={(e) => setRole(a.slug, e.target.value)} />
                  )}
                </div>
              )
            })}
          </div>
          {presentCount < 2 && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>{t('team.editor.needTwo')}</div>}
        </div>

        <div className="field-row">
          <div className="field">
            <label>{t('team.editor.mode')}</label>
            <select value={mode} onChange={(e) => setMode(e.target.value === 'collab' ? 'collab' : 'meeting')}>
              <option value="meeting">{t('team.editor.modeMeeting')}</option>
              <option value="collab">{t('team.editor.modeCollab')}</option>
            </select>
          </div>
          <div className="field">
            <label>{t('team.editor.rounds')}</label>
            <input type="number" min={1} max={30} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
          </div>
        </div>

        <div className="field">
          <label>{t('team.editor.doc')}</label>
          <textarea rows={7} value={doc} placeholder={t('team.editor.docPlaceholder')} onChange={(e) => setDoc(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={onClose}>{t('team.editor.cancel')}</button>
          <button className="btn primary sm" onClick={() => void save()} disabled={!canSave}>{team ? t('team.editor.save') : t('team.editor.create')}</button>
        </div>
      </div>
    </div>
  )
}
