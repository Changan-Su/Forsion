import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { BookOpen, NotebookPen, UserRound } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { AgentAvatar } from '../components/AgentAvatar'
import { HumanCollaborationPanel } from '../components/HumanCollaborationPanel'
import { homeTarget } from '../services/engine/targets'
import type { HumanFile, HumanJump } from '../services/humanCollaboration'
import '../components/humanMessages'
import './agentProfile.css'
import '../components/humanCollaboration.css'

// ponytail: 方案 ⑨ 的五个标签只做了有文件撑着的三个;日历(CALENDAR.db 搬家)和权限(「Agent 可以改」开关)等引擎那两步落地再加
type Section = 'collab' | 'portrait' | 'memory'
const SECTIONS = [{ id: 'collab', icon: BookOpen }, { id: 'portrait', icon: UserRound }, { id: 'memory', icon: NotebookPen }] as const

/** 「我」的名字和头像 = Forsion 账号;没登录叫「我」、字母头像。
 *  ponytail: 方案说没登录时用系统用户名,渲染层拿不到,要的话主进程补一个 os.userInfo 桥 */
export function useMeIdentity(): { name: string; avatar?: string } {
  const { t } = useI18n()
  const auth = useApp((s) => (s.authInfo?.loggedIn ? s.authInfo : null))
  return { name: auth?.nickname || auth?.username || t('human.me.label'), avatar: auth?.avatar || undefined }
}

/** 「我」资料页:human/ 文件夹的四份,和 Agent 详情同一个壳(头部 + 分段标签 + 滚动正文)。
 *  读写、修改记录、撤销都走 HumanCollaborationPanel(humanStore 的 history),这里只管摆放。jump = 对话里共识那份更新卡的深链。 */
export function HumanProfile({ jump }: { jump?: HumanJump }) {
  const { t } = useI18n()
  const id = useId()
  const cfg = useApp((s) => s.cfg)
  const me = useMeIdentity()
  const [section, setSection] = useState<Section>('collab')
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = (next: Section) => { setSection(next); scrollRef.current?.scrollTo({ top: 0 }) }
  useEffect(() => { if (jump?.at) navigate('collab') }, [jump?.at])
  const panel = (file: HumanFile, j?: HumanJump) => <HumanCollaborationPanel engine={homeTarget()} cfg={cfg} target={{ kind: 'human', file }} name={me.name} jump={j} />
  const index = SECTIONS.findIndex((x) => x.id === section)
  return <div className="agent-profile human-profile" data-human-profile>
    <header className="agent-character-hero">
      <div className="agent-portrait-slot"><span className="agent-portrait"><AgentAvatar name={me.name} url={me.avatar} fill /></span></div>
      <div className="agent-character-identity"><h2 className="agent-character-name">{me.name}</h2><p className="agent-character-desc">{t('human.me.caption')}</p></div>
    </header>
    <nav className="agent-section-nav" style={{ '--profile-tab-count': SECTIONS.length, '--profile-tab-index': index } as CSSProperties} aria-label={t('human.me.sections')} role="tablist" onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? SECTIONS.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
      navigate(SECTIONS[next].id); (e.currentTarget.children[next] as HTMLElement).focus()
    }}>{SECTIONS.map(({ id: tab, icon: Icon }) => <button key={tab} id={`${id}-${tab}`} role="tab" title={t(`human.me.${tab}`)} aria-selected={section === tab} aria-controls={`${id}-content`} tabIndex={section === tab ? 0 : -1} onClick={() => navigate(tab)} className={section === tab ? 'selected' : ''}><Icon size={15} /><span>{t(`human.me.${tab}`)}</span></button>)}</nav>
    <div ref={scrollRef} className="agent-profile-content" id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${section}`} tabIndex={0}>
      <div key={section} className="profile-section-enter">
        {/* 协作说明:上面是你写给 Agent 的(AGENT.md),下面是 Agent 们写的共识(HUMAN.md) */}
        {section === 'collab' && <>{panel('AGENT.md')}{panel('HUMAN.md', jump)}</>}
        {section === 'portrait' && panel('SOUL.md')}
        {section === 'memory' && panel('MEMORY.md')}
      </div>
    </div>
  </div>
}
