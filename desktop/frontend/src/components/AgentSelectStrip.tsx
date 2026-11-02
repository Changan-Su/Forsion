/**
 * 新对话「Agent 选择条」(轨道方案 §4 / §11 拍板 ⑦):把原来的两条选择器(EnginePicker + AgentPicker)
 * 合成**一条多选条** —— 左边是已选(按点选顺序、带序号、再点移除),竖线,右边是候选:
 * 本机 Agent + (execMode==='host' 时)可用外部引擎(CLI 视作特殊的独立 Agent,单选互斥)。
 *
 * 语义(§4 表):0 选 = 默认 Agent(清 agentSlug/engineId/groupChat,今天的行为);1 选 = `agentSlug`
 * (**仍是项目会话,不是私聊**);≥2 选 = 本会话进入**团队模式**(groupChat + groupAgents 按点选序;
 * 没有模式与轮数字段,成员各自以 DONE 表态收场),降回 1 立刻撤(引擎侧 <2 人整条 run failed,前端必须守 ≥2)。
 * 右键行 = 「私聊」(Agent 轨道的入口,与侧栏私聊行同一张表)+「设为默认」(名册的默认项,同 Agent 资料页)。
 *
 * 2026-11-02 起(方案页 docs/ToBeImproved/主页生成式组件方案_2026-11-02/agent.html,用户选 A):输入框上方那一排首字胶囊 + 状态句
 * 删掉,换成 Composer2 工具行里模式芯片右边的**收件人芯片**(`recipientChip` 槽,宽窄同一枚)。点开 = `CompactChatPicker` 的浮层
 * (顶上搜索、最多 8 行、↑↓ ↵ Esc);触屏抽屉、安卓原生勾选清单照旧。⌘⇧A / 命令面板「换 Agent」= `openAgentPicker`。
 * 团队仍是一种模式:模式芯片照写「团队 · N 人」,这里只叠头像写「X 等 N 位」。
 * `.agent-select-strip` / `.compact-chat-picker` 两个类名是仪器的抓手(check:chatlayout、phone-stage、session-mode)。
 */
import React, { useMemo, useState, useRef, useEffect } from 'react'
import { Loader2, MessageCircle, Star, Users } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { commandHotkeyText, nativeSheetPresenter, presentNativeChecklist } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { EngineIcon } from './EngineIcon'
import { CompactChatPicker, type ChatPickItem } from './CompactChatPicker'
import { ContextMenu, type CtxItem, type CtxMenu } from './RightPanel'
import { useApp } from '../stores/appStore'
import { newChatProjectPath } from '../tangu/store/tanguSlice'
import { currentPlatform } from '../services/agentRunService'
import { projectDefaultsForNewSession } from '../stores/projectSettings'
import { draftDispatch } from './agentSelectStatus'
import { AgentAvatar, initialFor } from './AgentAvatar'
import { openSolo } from '../sessionNav'
import { putAgentsMeta } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import type { AgentConfig } from '../types'
import { agentName, agentNames } from '../agentName'

registerMessages({
  'agentSelect.title': { zh: '选择 Agent', en: 'Pick agents' },
  // 提示行是**状态句**(评审 U-09):0 选 = 默认 Agent 照样能发,不是「请先选择」。
  'agentSelect.hintDefault': { zh: '由默认 Agent {name} 处理', en: 'Handled by the default agent, {name}' },
  'agentSelect.hintDefaultAnon': { zh: '由默认 Agent 处理', en: 'Handled by the default agent' },
  'agentSelect.hintOne': { zh: '{name} 将处理这条消息', en: '{name} will handle this message' },
  'agentSelect.team': { zh: '团队模式 · {n} 人', en: 'Team mode · {n} people' },
  // 芯片上的团队:zh 说总人数,en 说另外几位(方案页定稿的两种写法,故占位符不同:n = 总数,m = n - 1)
  'agentSelect.chipTeam': { zh: '{name} 等 {n} 位', en: '{name} +{m}' },
  'agentSelect.default': { zh: '默认 Agent', en: 'Default agent' },
  'agentSelect.defaultTag': { zh: '默认', en: 'Default' },
  'agentSelect.sessionTag': { zh: '本会话', en: 'This session' },
  'agentSelect.direct': { zh: '私聊', en: 'Direct chat' },
  'agentSelect.makeDefault': { zh: '设为默认', en: 'Set as default' },
  'agentSelect.search': { zh: '找 Agent 或引擎', en: 'Find an agent or engine' },
  'agentSelect.switch': { zh: '换 Agent', en: 'Switch agent' },
})

/**
 * ⌘⇧A / 命令面板「换 Agent」:点开当前看得见的那枚芯片 —— 已开着的优先(再按一次 = 收起),其次焦点所在的输入卡,再次第一枚。
 * 没有芯片(会话已开聊 / Chat 预设)就什么都不做:会话中换人照旧走模式菜单「普通模式 ›」。
 * ponytail: 按 DOM 找芯片,不另设广播;分屏里两张输入卡都空着时焦点不在卡里就取第一张。
 */
export function openAgentPicker(): void {
  const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-select-strip .compact-chat-picker')).filter((el) => el.getClientRects().length > 0)
  const card = document.activeElement?.closest('.t2c-card')
  ;(chips.find((el) => el.getAttribute('aria-expanded') === 'true') ?? chips.find((el) => card?.contains(el)) ?? chips[0])?.click()
}

/** 进团队模式的人数下限(引擎侧 <2 人整条 run failed);也是「画发言序号」的门槛 —— 单选没有顺序可言。 */
const TEAM_MIN = 2

type Candidate =
  // session = 名册里没有、只活在本会话的(临时成员 / 已删的):排在顶上带「本会话」标,能取消
  | { id: string; kind: 'agent'; slug: string; name: string; names: string[]; description?: string; system?: boolean; session?: boolean }
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
    teams: state.teams,
  })))
  // 新对话:发送那一刻会按项目默认项补 Agent / 团队(appStore.send → newChatProjectPath + projectDefaultsForNewSession,
  // 只补草稿里缺席的键)。状态句得说同一个人:项目落点与发送链同一个解析(含未显式选项目时的隐式默认工作区)。
  const draftProjectPath = useApp((st) => (sessionId ? null : newChatProjectPath(st, currentPlatform())))
  const draftProject = useApp((st) => (draftProjectPath ? st.projectSettingsByPath[draftProjectPath] ?? null : null))
  const draftProjectKnown = useApp((st) => !draftProjectPath || draftProjectPath in st.projectSettingsByPath)
  // 默认工作区从不经 setNewChatWs 预取:缓存还冷就在这里取一次(send 冷缓存时也会等这同一份)。
  useEffect(() => {
    if (draftProjectPath && !draftProjectKnown) void useApp.getState().ensureProjectSettings(draftProjectPath).catch(() => null)
  }, [draftProjectPath, draftProjectKnown])

  const engineId = cfg.engineId || ''
  const pickedSlugs = pickedAgentSlugs(cfg)
  const pickedIds = engineId ? [engineKey(engineId)] : pickedSlugs.map(agentId)
  // 引擎预热(探测能力,npx 冷启)期间:那一行(和芯片)转圈,其余行禁用。
  const warming = engineId && !s.engineCaps[engineId] ? engineId : ''

  const items = useMemo<Candidate[]>(() => {
    const roster: Candidate[] = s.agentDefs.map((a) => ({
      id: agentId(a.slug), kind: 'agent', slug: a.slug, name: agentName(a), names: agentNames(a), description: a.description, system: a.createdBy === 'system',
    }))
    const known = (slug: string): boolean => roster.some((i) => i.id === agentId(slug))
    const extras: Candidate[] = []
    // 老群聊会话里的临时 / 已删 agent 也要能显示与移除 —— 过滤掉等于下一次写入时静默丢成员。
    for (const slug of cfg.groupAgents ?? []) {
      if (known(slug) || extras.some((i) => i.id === agentId(slug))) continue
      const temp = cfg.groupTempAgents?.find((a) => a.slug === slug)
      const name = agentName(temp) || slug
      extras.push({ id: agentId(slug), kind: 'agent', slug, name, names: [name], description: temp?.description, session: true })
    }
    // 已钉住但已被删的单个 agent 同理:不画出来用户就退不掉它(会话仍按它跑)。
    if (cfg.agentSlug && !known(cfg.agentSlug) && !extras.some((i) => i.id === agentId(cfg.agentSlug!))) {
      extras.push({ id: agentId(cfg.agentSlug), kind: 'agent', slug: cfg.agentSlug, name: cfg.agentSlug, names: [], session: true })
    }
    const list = [...extras, ...roster]
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
  const siblingNames = useMemo(() => items.filter((i) => i.kind === 'agent').map((i) => i.name), [items])
  const picked = pickedIds.map((id) => byId.get(id)).filter((i): i is Candidate => !!i)
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

  const toggle = (item: Candidate): void => {
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
    return <AgentAvatar name={item.name} url={s.agentAvatars[item.slug]} siblings={siblingNames} imgClassName="agent-pill-avatar" initialClassName="agent-pill-initial" />
  }

  // 「设为默认」= Agent 资料页名册里的同一个操作(AgentProfileView.setDefault)。
  const makeDefault = async (slug: string): Promise<void> => {
    try {
      const meta = await putAgentsMeta(homeTarget(), { defaultSlug: slug })
      useApp.setState({ defaultAgentSlug: meta.defaultSlug })
      window.dispatchEvent(new Event('forsion:agents-changed'))
      window.tangu?.requestMainAction?.('agents-changed')
    } catch (error) {
      useApp.getState().toast(String((error as Error)?.message || error), true)
    }
  }
  const rowMenu = (id: string, at: { x: number; y: number }, close: () => void): void => {
    const item = byId.get(id)
    if (!item) return
    const entries: CtxItem[] = [{ label: t('agentSelect.direct'), icon: <MessageCircle size={13} />, run: () => { close(); openDirect(item) } }]
    // 只给名册里的人:临时 / 已删的没法当默认
    if (item.kind === 'agent' && !item.session) {
      entries.push({ label: t('agentSelect.makeDefault'), icon: <Star size={13} />, disabled: item.slug === s.defaultAgentSlug, run: () => void makeDefault(item.slug) })
    }
    setMenu({ ...at, items: entries })
  }

  // 原生清单开着时会话可能被换掉 / 本组件被卸掉:回来的结果只认发起它的那一轮,且用最新的 applyAgents 写(评审 10-24)。
  const nativeAbort = useRef<AbortController | null>(null)
  const applyLatest = useRef(applyAgents)
  applyLatest.current = applyAgents
  useEffect(() => () => nativeAbort.current?.abort(), [sessionId])

  // Chat 预设恒 sandbox + 无 agent(applyPreset 会抹掉 agentSlug/cwd),不露选择条;没有任何候选同理。
  if (cfg.preset === 'chat' || !items.length) return null

  // 状态句(浮层底部 / 抽屉标题下 / 原生清单脚注):≥2 人 = 团队行;1 人 = 谁来接;
  // 0 人 = 发送时实际接手的人(项目默认 Agent / 团队,再兜全局默认)。
  const dispatch = draftDispatch(cfg, sessionId ? {} : projectDefaultsForNewSession(draftProject, Array.isArray(s.teams) ? s.teams : []).config, s.defaultAgentSlug)
  const defaultAgent = dispatch.kind === 'agent' && dispatch.slug ? byId.get(agentId(dispatch.slug)) : undefined
  const statusLine = teamCount >= TEAM_MIN
    ? t('agentSelect.team', { n: teamCount })
    : picked.length === 1
      ? t('agentSelect.hintOne', { name: picked[0].name })
      : dispatch.kind === 'team'
        ? t('agentSelect.team', { n: dispatch.count })
        : defaultAgent ? t('agentSelect.hintDefault', { name: defaultAgent.name }) : t('agentSelect.hintDefaultAnon')

  // 芯片写的是「谁在接」:团队叠头像(最多 3)+「X 等 N 位」(不再说「团队」—— 模式芯片已在说);
  // 没选 = 默认那位的头像 + 名字;项目默认是团队时方案没画,用团队图标 + 状态句兜住。
  const isTeam = picked.length >= TEAM_MIN
  const chipIcon = isTeam
    ? <span className="chat-pick-stack">{picked.slice(0, 3).map((item) => <React.Fragment key={item.id}>{pillIcon(item)}</React.Fragment>)}</span>
    : picked[0] ? pillIcon(picked[0])
      : dispatch.kind === 'team' ? <Users size={13} />
        : defaultAgent ? pillIcon(defaultAgent) : <EngineIcon engineId="" size={16} />
  const chipName = isTeam ? t('agentSelect.chipTeam', { name: picked[0].name, n: picked.length, m: picked.length - 1 })
    : picked[0] ? picked[0].name
      : dispatch.kind === 'team' ? t('agentSelect.team', { n: dispatch.count })
        : defaultAgent?.name || t('agentSelect.default')
  const markOf = (id: string): true | number | undefined => {
    const at = pickedIds.indexOf(id)
    return at < 0 ? undefined : isTeam ? at + 1 : true
  }
  const tag = (text: string): React.ReactElement => <span key={text} className="agent-badge-system">{text}</span>
  const badgeOf = (i: Candidate): React.ReactNode => {
    if (i.kind !== 'agent') return undefined
    if (i.session) return tag(t('agentSelect.sessionTag'))
    const tags = [i.slug === s.defaultAgentSlug && tag(t('agentSelect.defaultTag')), i.system && tag(t('agent.badge.system'))].filter(Boolean)
    return tags.length ? tags : undefined
  }
  // 行:头像 + 名字 + 默认 / 后台 / 本会话标 + 勾或序号;简介进说明区。点行 = toggle,浮层不收。
  const pickItems: ChatPickItem[] = [
    { id: '', name: t('agentSelect.default'), icon: <EngineIcon engineId="" size={18} />, mark: picked.length ? undefined : true, disabled: !!warming, separatorAfter: items.length > 0 },
    ...items.map((i): ChatPickItem => ({
      id: i.id,
      name: i.name,
      description: i.kind === 'agent' ? i.description : undefined,
      keywords: i.kind === 'agent' ? [i.slug, ...i.names] : [i.engineId],
      icon: pillIcon(i),
      mark: markOf(i.id),
      badge: badgeOf(i),
      disabled: !!warming && i.id !== engineKey(warming),
      section: i.kind === 'engine' ? t('chatPicker.engines') : undefined,
      direct: true,
    })),
  ]
  // 安卓原生外壳:原生勾选清单(按勾选顺序 = 发言顺序,关上时一起生效;10-24 用户选定)。
  // 引擎是单选互斥,清单表达不了 —— 列表里有引擎就留给网页面(引擎只在本机执行的会话里出现,手机上碰不到)。
  const openNative = (fallback: () => void): boolean => {
    if (!nativeSheetPresenter() || items.some((i) => i.kind === 'engine')) return false
    nativeAbort.current?.abort()
    const ctrl = new AbortController()
    nativeAbort.current = ctrl
    const agents = items.filter((i): i is Extract<Candidate, { kind: 'agent' }> => i.kind === 'agent')
    void presentNativeChecklist({
      title: t('agentSelect.title'),
      items: agents.map((a) => ({ id: a.id, label: a.name, icon: initialFor(a.name, siblingNames) })),
      checked: pickedIds.filter((id) => agents.some((a) => a.id === id)),
      footer: statusLine,
      done: t('chatPicker.done'),
      min: 0,
      max: agents.length,
    }, ctrl.signal).then((out) => {
      if (ctrl.signal.aborted) return
      if (!out.handled) { fallback(); return }
      if (out.value) applyLatest.current(out.value.checked.map((id) => id.slice('agent:'.length)))
    })
    return true
  }
  return (
    <span className="agent-select-strip t2c-capsule-peer" role="group" aria-label={t('agentSelect.title')}>
      <CompactChatPicker
        title={t('agentSelect.title')}
        icon={chipIcon}
        name={chipName}
        status={statusLine}
        items={pickItems}
        onPick={(id) => {
          if (!id) { clearAll(); return }
          const item = byId.get(id)
          if (item) toggle(item)
        }}
        // 「默认 Agent」= 清空,和选了引擎(单选互斥)一样收起;选 Agent 不收,好接着组队
        closeOnPick={(id) => !id || byId.get(id)?.kind === 'engine'}
        onDirect={(id) => { const item = byId.get(id); if (item) openDirect(item) }}
        directLabel={t('agentSelect.direct')}
        onNative={openNative}
        onRowMenu={rowMenu}
        searchLabel={t('agentSelect.search')}
        hotkeyHint={commandHotkeyText('switch-agent') || undefined} // features/tangu 注册的那条;分平台、跟用户改过的键走
        busy={!!warming}
      />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </span>
  )
}
