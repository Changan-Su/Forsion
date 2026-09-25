/**
 * 新对话「Agent 选择条」(轨道方案 §4 / §11 拍板 ⑦):把原来的两条选择器(EnginePicker + AgentPicker)
 * 合成**一条多选条** —— 左边是已选(按点选顺序、带序号、再点移除),竖线,右边是候选:
 * 本机 Agent + (execMode==='host' 时)可用外部引擎(CLI 视作特殊的独立 Agent,单选互斥)。
 *
 * 语义(§4 表):0 选 = 默认 Agent(清 agentSlug/engineId/groupChat,今天的行为);1 选 = `agentSlug`
 * (**仍是项目会话,不是私聊**);≥2 选 = 本会话进入**团队模式**(groupChat + groupAgents 按点选序;
 * 没有模式与轮数字段,成员各自以 DONE 表态收场),降回 1 立刻撤(引擎侧 <2 人整条 run failed,前端必须守 ≥2)。
 * 右键 / 长按 pill = 「私聊」(Agent 轨道的入口,与侧栏私聊行同一张表)。
 *
 * 样式复用既有 `.engine-picker` / `.engine-pill` / `.agent-pill-avatar` 一套(base.css 不动;序号徽章 / 竖线在 agentSelectStrip.css):
 * `.agent-pill` / `.agent-select-strip` 只是**仪器与结构的抓手**,视觉仍由 `.engine-pill` 提供;
 * 窄栏(≤520px 容器查询)折叠成单个 `CompactChatPicker` 也是白拿 —— 见 components/compactChatPicker.css,
 * 它按 `.newchat-pickers > .engine-picker > .engine-picker-bar/-hint` 收起,故根节点必须留在那个位置。
 */
import React, { useMemo, useState, useRef, useEffect } from 'react'
import { Loader2, MessageCircle } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { registerMessages, useI18n } from '../i18n'
import { EngineIcon } from './EngineIcon'
import { PillBar } from './EnginePicker'
import { CompactChatPicker } from './CompactChatPicker'
import { ContextMenu, menuPos, type CtxMenu } from './RightPanel'
import { useApp } from '../stores/appStore'
import { AgentAvatar } from './AgentAvatar'
import { openSolo } from '../sessionNav'
import type { AgentConfig } from '../types'
import './agentSelectStrip.css'

registerMessages({
  'agentSelect.title': { zh: '选择 Agent', en: 'Pick agents' },
  // 提示行是**状态句**(评审 U-09):0 选 = 默认 Agent 照样能发,不是「请先选择」。
  'agentSelect.hintDefault': { zh: '由默认 Agent {name} 处理', en: 'Handled by the default agent, {name}' },
  'agentSelect.hintDefaultAnon': { zh: '由默认 Agent 处理', en: 'Handled by the default agent' },
  'agentSelect.hintOne': { zh: '{name} 将处理这条消息', en: '{name} will handle this message' },
  'agentSelect.removeHint': { zh: '再次点击移除', en: 'Click again to remove' },
  'agentSelect.team': { zh: '团队模式 · {n} 人', en: 'Team mode · {n} people' },
  'agentSelect.picked': { zh: '已选', en: 'Picked' },
  'agentSelect.default': { zh: '默认 Agent', en: 'Default agent' },
  'agentSelect.defaultTag': { zh: '默认', en: 'Default' },
  'agentSelect.direct': { zh: '私聊', en: 'Direct chat' },
})

/** 进团队模式的人数下限(引擎侧 <2 人整条 run failed);也是「画发言序号」的门槛 —— 单选没有顺序可言。 */
const TEAM_MIN = 2

type Candidate =
  | { id: string; kind: 'agent'; slug: string; name: string; description?: string; system?: boolean }
  | { id: string; kind: 'engine'; engineId: string; name: string }

const agentId = (slug: string): string => `agent:${slug}` // §9 前缀隔离:slug 与 engineId 可能同名(codex)
const engineKey = (id: string): string => `engine:${id}`

const sameOrder = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** 本会话/新对话当前已选的 agent slug(按顺序);引擎选中时恒空。 */
export function pickedAgentSlugs(cfg: AgentConfig): string[] {
  if (cfg.engineId) return []
  const group = cfg.groupAgents ?? []
  if (cfg.groupChat && group.length >= 2) return [...group]
  return cfg.agentSlug ? [cfg.agentSlug] : []
}

/**
 * @param sessionId 既有空白会话 id;`null` = 新对话(写 newChatCfg)。
 * @param cfg 该会话/新对话的**有效**配置(ChatView 的 mvCfg / 主页的 config)。
 */
export function AgentSelectStrip({ sessionId, cfg }: { sessionId: string | null; cfg: AgentConfig }): React.ReactElement | null {
  const { t } = useI18n()
  const [menu, setMenu] = useState<CtxMenu>(null)
  const s = useApp(useShallow((state) => ({
    agentDefs: state.agentDefs,
    agentAvatars: state.agentAvatars,
    defaultAgentSlug: state.defaultAgentSlug,
    engines: state.engines,
    engineCaps: state.engineCaps,
  })))

  const engineId = cfg.engineId || ''
  const pickedSlugs = pickedAgentSlugs(cfg)
  const pickedIds = engineId ? [engineKey(engineId)] : pickedSlugs.map(agentId)
  // 引擎预热(探测能力,npx 冷启)期间照 EnginePicker 的老规矩:本 pill 转圈,其余禁用。
  const warming = engineId && !s.engineCaps[engineId] ? engineId : ''

  const items = useMemo<Candidate[]>(() => {
    const list: Candidate[] = s.agentDefs.map((a) => ({
      id: agentId(a.slug), kind: 'agent', slug: a.slug, name: a.name, description: a.description, system: a.createdBy === 'system',
    }))
    // 老群聊会话里的临时 / 已删 agent 也要能显示与移除 —— 过滤掉等于下一次写入时静默丢成员。
    for (const slug of cfg.groupAgents ?? []) {
      if (list.some((i) => i.id === agentId(slug))) continue
      const temp = cfg.groupTempAgents?.find((a) => a.slug === slug)
      list.push({ id: agentId(slug), kind: 'agent', slug, name: temp?.name || slug, description: temp?.description })
    }
    // 已钉住但已被删的单个 agent 同理:不画出来用户就退不掉它(会话仍按它跑)。
    if (cfg.agentSlug && !list.some((i) => i.id === agentId(cfg.agentSlug!))) {
      list.push({ id: agentId(cfg.agentSlug), kind: 'agent', slug: cfg.agentSlug, name: cfg.agentSlug })
    }
    // 外部引擎只在 host 会话里当候选(§11 ⑦:CLI 视作特殊的独立 Agent);
    // 已经选中的那一枚无论如何都要在场,否则用户退不掉它。
    if (cfg.execMode === 'host') {
      for (const e of s.engines) if (e.available) list.push({ id: engineKey(e.id), kind: 'engine', engineId: e.id, name: e.name })
    }
    if (engineId && !list.some((i) => i.id === engineKey(engineId))) {
      list.push({ id: engineKey(engineId), kind: 'engine', engineId, name: s.engines.find((e) => e.id === engineId)?.name || engineId })
    }
    return list
  }, [s.agentDefs, s.engines, engineId, cfg.execMode, cfg.groupAgents, cfg.groupTempAgents, cfg.agentSlug])

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const agentNames = useMemo(() => items.filter((i) => i.kind === 'agent').map((i) => i.name), [items])
  const picked = pickedIds.map((id) => byId.get(id)).filter((i): i is Candidate => !!i)
  const candidates = items.filter((i) => !pickedIds.includes(i.id))
  const teamCount = cfg.groupChat ? pickedSlugs.length : 0

  /** 写入已选 Agent 集合(顺序即发言序);≥2 进团队模式,≤1 撤销。 */
  const applyAgents = (next: string[]): void => {
    // `groupChat:true` 但成员 <2(半配置的旧会话 / GroupChatSetup 中途退出)= 发出去就是整条 run failed。
    // 这种脏态**不许**被「没变化」提前返回吃掉,必须借这次操作补一发 groupChat:false。
    const groupStale = !!cfg.groupChat && pickedSlugs.length < TEAM_MIN
    if (!engineId && !groupStale && sameOrder(pickedSlugs, next)) return
    const st = useApp.getState()
    const dropEngine = !!engineId
    // 一次操作只发**一笔**整包 PUT(几笔并发整体替换,「最后调用」不保证最后落库);临时 Agent 随成员集合一起清理,免得下次打开浮层复活。
    const temps = (cfg.groupTempAgents || []).filter((a) => next.includes(a.slug))
    const engineOff = dropEngine ? { engineId: undefined, engineModelId: undefined } : {}
    if (next.length >= TEAM_MIN) {
      const patch = { groupChat: true, groupAgents: next, groupTempAgents: temps.length ? temps : undefined, ...engineOff }
      if (sessionId) st.patchSessionConfig(patch, sessionId)
      else st.setNewChatCfg((c) => ({ ...c, ...patch }))
      return
    }
    // 降回 ≤1:立刻撤团队模式(引擎侧 <2 人整条 run failed),并把人写进 agentSlug —— 同一笔。
    const slug = next[0] || ''
    const off = { groupChat: false, groupAgents: undefined, groupTempAgents: undefined, ...engineOff }
    if (sessionId) {
      st.selectSessionAgent(slug, sessionId, off)
    } else {
      st.setNewChatCfg((c) => ({ ...c, ...off }))
      st.selectNewChatAgent(slug)
    }
  }

  /** 引擎单选互斥:选中即清掉全部 Agent 与团队模式;再点一次退回内置 Tangu。 */
  const applyEngine = (id: string): void => {
    const st = useApp.getState()
    if (sessionId) {
      st.setSessionEngine(id, sessionId) // 选中引擎时内部同一笔写 groupChat:false / groupAgents / agentSlug 清空
    } else {
      st.setNewChatCfg((c) => ({
        ...c,
        engineId: id || undefined,
        engineModelId: undefined,
        ...(id ? { groupChat: false, groupAgents: undefined, agentSlug: undefined } : {}),
      }))
    }
  }

  // 切换后把键盘焦点还给同一枚 pill:pill 在「已选 / 候选」两段间移动会被 React 重挂(两段是不同的 children 槽位),焦点会掉到 body。
  const refocusId = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = refocusId.current
    if (!id) return
    refocusId.current = null
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-pill-id="${CSS.escape(id)}"]`)
    el?.focus()
  })
  const toggle = (item: Candidate): void => {
    refocusId.current = item.id
    if (item.kind === 'engine') { applyEngine(item.engineId === engineId ? '' : item.engineId); return }
    const next = pickedSlugs.includes(item.slug) ? pickedSlugs.filter((x) => x !== item.slug) : [...pickedSlugs, item.slug]
    applyAgents(next)
  }

  // 引擎选中时 pickedSlugs 恒空,故退掉引擎就是「清空」;没有引擎时清的是 Agent 与团队模式。
  const clearAll = (): void => { if (engineId) applyEngine(''); else applyAgents([]) }

  // 私聊入口与侧栏行共用 sessionNav 的同一扇门(agent → soloAgentSlug,engine → soloEngineId)。
  const openDirect = (item: Candidate): void => {
    if (item.kind === 'agent') openSolo('agent', item.slug)
    else openSolo('engine', item.engineId)
  }

  const pillIcon = (item: Candidate): React.ReactNode => {
    if (item.kind === 'engine') return warming === item.engineId ? <Loader2 size={16} className="spin" /> : <EngineIcon engineId={item.engineId} size={16} />
    // 首字一律中性底色(09-25 拍板);同姓撞字靠 initialFor 在同屏名字里取不同的字。
    return <AgentAvatar name={item.name} url={s.agentAvatars[item.slug]} siblings={agentNames} imgClassName="agent-pill-avatar" initialClassName="agent-pill-initial" />
  }

  const pillTitle = (item: Candidate, isPicked: boolean): string => {
    const base = item.kind === 'agent' && item.description ? `${item.name} — ${item.description}` : item.name
    if (isPicked) return `${base} · ${t('agentSelect.removeHint')}`
    if (item.kind === 'agent' && item.slug === s.defaultAgentSlug) return `${base} · ${t('agentSelect.defaultTag')}`
    return base
  }

  const renderPill = (item: Candidate, order: number | null): React.ReactElement => {
    const isPicked = order !== null
    const warmingThis = item.kind === 'engine' && warming === item.engineId
    return (
      <button
        key={item.id}
        type="button"
        aria-pressed={isPicked}
        data-pill-id={item.id}
        className={`engine-pill agent-pill${isPicked ? ' selected' : ''}`}
        data-agent-slug={item.kind === 'agent' ? item.slug : undefined}
        data-engine-id={item.kind === 'engine' ? item.engineId : undefined}
        title={pillTitle(item, isPicked)}
        disabled={!!warming && !warmingThis}
        onClick={() => { if (!warming || warmingThis) toggle(item) }}
        onContextMenu={(e) => {
          e.preventDefault() // 触屏长按在 Chromium 同样发 contextmenu,两种入口共用这一条
          setMenu({ ...menuPos(e), items: [{ label: t('agentSelect.direct'), icon: <MessageCircle size={13} />, run: () => openDirect(item) }] })
        }}
      >
        {isPicked && picked.length >= TEAM_MIN && <span className="agent-pill-index">{(order as number) + 1}</span>}
        <span className="engine-pill-icon">{pillIcon(item)}</span>
        <span className="engine-pill-label">{item.name}</span>
        {item.kind === 'agent' && item.system && <span className="agent-badge-system">{t('agent.badge.system')}</span>}
      </button>
    )
  }

  // Chat 预设恒 sandbox + 无 agent(applyPreset 会抹掉 agentSlug/cwd),不露选择条;没有任何候选同理。
  if (cfg.preset === 'chat' || !items.length) return null

  // 状态句:≥2 人 = 团队行;1 人 = 谁来接;0 人 = 默认 Agent 接(照样能发)。「再点移除」只留在已选 pill 的 title 里。
  const defaultName = s.agentDefs.find((a) => a.slug === s.defaultAgentSlug)?.name
  const statusLine = teamCount >= TEAM_MIN
    ? t('agentSelect.team', { n: teamCount })
    : picked.length === 1
      ? t('agentSelect.hintOne', { name: picked[0].name })
      : defaultName ? t('agentSelect.hintDefault', { name: defaultName }) : t('agentSelect.hintDefaultAnon')

  const compactValue = pickedIds[0] || ''
  const compactIcon = picked[0] ? pillIcon(picked[0]) : <EngineIcon engineId="" size={16} />
  return (
    <div ref={rootRef} className="engine-picker agent-picker agent-select-strip" role="group" aria-label={t('agentSelect.title')}>
      {/* 窄栏芯片的前缀要短,故用既有的「Agent」词条;整条的可访问名走根节点 aria-label。 */}
      <CompactChatPicker
        label={t('chatPicker.agent')}
        value={compactValue}
        icon={compactIcon}
        options={[
          { value: '', name: t('agentSelect.default') },
          ...items.map((i) => ({
            value: i.id,
            name: i.name,
            // 原生 select 选不掉自己,故「已选」只作说明写进选项正文,name 保持干净(仪器读它)。
            description: pickedIds.includes(i.id) ? t('agentSelect.picked') : (i.kind === 'agent' ? i.description : undefined),
            disabled: !!warming && i.id !== engineKey(warming),
          })),
        ]}
        onChange={(value) => {
          if (!value) { clearAll(); return }
          const item = byId.get(value)
          if (item) toggle(item)
        }}
        busy={!!warming}
      />
      <PillBar label={t('agentSelect.title')} role="group">
        {/* 单一 children 数组(同一键空间):pill 从候选段挪到已选段时 React 移动节点而不是重挂。 */}
        {[
          ...picked.map((item, i) => renderPill(item, i)),
          ...(picked.length > 0 ? [<span key="sep" className="agent-select-sep" aria-hidden="true" />] : []),
          ...candidates.map((item) => renderPill(item, null)),
        ]}
      </PillBar>
      <div className={`engine-picker-hint${teamCount >= TEAM_MIN ? ' agent-select-team' : ''}`}>{statusLine}</div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
