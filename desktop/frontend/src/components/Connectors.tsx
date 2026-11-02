/**
 * 连接器(连接器方案 2026-10-23「商店与设置页」):商店「连接器」分类的卡片网格 + 设置 → MCP 服务器顶部那一块。
 * 只在桌面出现(window.tangu.connectorsList,宿主声明);目录来自后台,不是市场列表;按钮是「连接 / 已连接」,不是「安装」。
 * 流程见 services/connectorService.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Info, KeyRound, Lock, LogIn, LogOut, Plug, Store, Unplug, Wrench } from 'lucide-react'
import { Skeleton } from '@lcl/engine'
import './Connectors.css'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import type { ConnectorCatalog, ConnectorEntry, McpServerConfigEntry } from '../types'
import { SettingsPanel, SettingsRow, SettingsState, SettingsSwitch } from './SettingsPrimitives'
import { listTools, mcpLogout } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import {
  connectConnector, connectorDescription, connectorName, connectorRows, disconnectConnector, loginConnector, submitConnectorKey,
  type ConnectResult, type McpRow,
} from '../services/connectorService'

registerMessages({
  'connectors.tab': { zh: '连接器', en: 'Connectors' },
  'connectors.subtitle': { zh: '由 Forsion 官方收录。连接后，Agent 可以用你在这些服务里的数据，登录只保存在这台电脑上', en: 'Curated by Forsion. Once connected, agents can use your data in these services. Sign-ins stay on this computer.' },
  'connectors.connect': { zh: '连接', en: 'Connect' },
  'connectors.connecting': { zh: '连接中…', en: 'Connecting…' },
  'connectors.signIn': { zh: '登录', en: 'Sign in' },
  'connectors.enterKey': { zh: '填写 Key', en: 'Enter key' },
  'connectors.keyPlaceholder': { zh: '粘贴你的 Key', en: 'Paste your key' },
  'connectors.keySave': { zh: '保存并连接', en: 'Save and connect' },
  'connectors.keyApply': { zh: '去哪申请 Key', en: 'Get a key' },
  'connectors.keyHint': { zh: 'Key 只保存在这台电脑上，不会上传到 Forsion', en: 'Your key is saved only on this computer and never uploaded to Forsion.' },
  'connectors.keyRejected': { zh: '这个 Key 没有通过，请检查后重填', en: 'This key was not accepted. Check it and try again.' },
  'connectors.browserOpened': { zh: '已在浏览器打开「{name}」的登录页，完成后会自动连接', en: 'Opened the sign-in page for "{name}" in your browser. It connects when you finish.' },
  'connectors.nowConnected': { zh: '已连接「{name}」，新工具从下一轮对话起可用', en: 'Connected "{name}". Its tools are available from your next message.' },
  'connectors.pending': { zh: '有回复正在生成，等它结束后再连接', en: 'A reply is still running. Try again when it finishes.' },
  'connectors.failed': { zh: '「{name}」没有连上：', en: 'Couldn’t connect "{name}": ' },
  'connectors.offline': { zh: '暂时连不上 Forsion，显示的是上次保存的目录', en: 'Can’t reach Forsion right now. Showing the last saved list.' },
  'connectors.loadFailed': { zh: '连接器目录加载失败', en: 'Couldn’t load connectors' },
  'connectors.empty': { zh: '暂时还没有连接器', en: 'No connectors yet' },
  'connectors.retry': { zh: '重试', en: 'Retry' },
  'connectors.server': { zh: '服务地址 {host}', en: 'Server {host}' },
  'connectors.addFromStore': { zh: '去商店添加', en: 'Add from the store' },
  'connectors.retired': { zh: '已下线', en: 'Retired' },
  'connectors.retiredHint': { zh: 'Forsion 已不再提供这个连接器。它还能用，你可以随时断开', en: 'Forsion no longer offers this connector. It still works, and you can disconnect it any time.' },
  'connectors.statusConnected': { zh: '已连接 · {n} 个工具', en: 'Connected · {n} tools' },
  'connectors.statusNeedsLogin': { zh: '需要登录', en: 'Sign-in required' },
  'connectors.statusNeedsKey': { zh: '需要 Key', en: 'Key required' },
  'connectors.statusLoggingIn': { zh: '登录中…', en: 'Signing in…' },
  'connectors.statusConnecting': { zh: '连接中…', en: 'Connecting…' },
  'connectors.statusError': { zh: '连接出错', en: 'Connection error' },
  'connectors.statusPending': { zh: '等待接入', en: 'Waiting to connect' },
  'connectors.disconnect': { zh: '断开', en: 'Disconnect' },
  'connectors.disconnectConfirm': { zh: '断开「{name}」？这台电脑上保存的登录或 Key 会删掉，Agent 也不能再用它', en: 'Disconnect "{name}"? The sign-in or key saved on this computer will be removed and agents can no longer use it.' },
  'connectors.disconnected': { zh: '已断开「{name}」', en: 'Disconnected "{name}"' },
  'connectors.pageHint': { zh: 'Forsion 官方收录的服务。连接后 Agent 能用你在这些服务里的数据；登录和 Key 只保存在这台电脑上。', en: 'Services curated by Forsion. Once connected, agents can use your data in them. Sign-ins and keys stay on this computer.' },
  'connectors.connectedCount': { zh: '已连接 · {n}', en: 'Connected · {n}' },
  'connectors.openRowHint': { zh: '点一行看登录、权限和工具', en: 'Open one to see its sign-in, access and tools' },
  'connectors.manualHint': { zh: '自己添加的 MCP 服务器在「MCP 服务器」页，不算连接器。', en: 'MCP servers you added yourself are on the MCP servers page.' },
  'connectors.allConnectors': { zh: '全部连接器', en: 'All connectors' },
  'connectors.status': { zh: '状态', en: 'Status' },
  'connectors.tokens': { zh: '每次请求约 {n} token', en: 'About {n} tokens per request' },
  'connectors.notSignedIn': { zh: '还没登录，Agent 暂时用不了它；登录后工具从下一轮对话起可用', en: 'Not signed in, so agents can’t use it yet. Tools appear from your next message after you sign in.' },
  'connectors.noKeyYet': { zh: '还没填 Key，Agent 暂时用不了它', en: 'No key yet, so agents can’t use it.' },
  'connectors.loggingInHint': { zh: '已在浏览器打开 {host} 的登录页，完成后会自动连上', en: 'Opened the {host} sign-in page in your browser. It connects when you finish.' },
  'connectors.disabledHint': { zh: '已停用：登录保留，Agent 暂时看不到它的工具', en: 'Turned off. The sign-in is kept, but agents can’t see its tools.' },
  'connectors.reopen': { zh: '重新打开', en: 'Open again' },
  'connectors.signInRow': { zh: '登录', en: 'Sign-in' },
  'connectors.signedInOAuth': { zh: '已用 {name} 账号登录（OAuth），登录信息只保存在这台电脑上', en: 'Signed in with your {name} account (OAuth). The sign-in is saved only on this computer.' },
  'connectors.signInAgain': { zh: '重新登录', en: 'Sign in again' },
  'connectors.signOut': { zh: '退出登录', en: 'Sign out' },
  'connectors.keySaved': { zh: '已填 Key，只保存在这台电脑上', en: 'Key saved, only on this computer' },
  'connectors.keyMissing': { zh: '还没填', en: 'Not set' },
  'connectors.changeKey': { zh: '更换 Key', en: 'Change key' },
  'connectors.access': { zh: '申请的权限', en: 'Access requested' },
  'connectors.accessByConsent': { zh: '{name} 没有单列权限，按你在授权页上选的为准', en: '{name} doesn’t list scopes. Access follows what you chose on its consent page.' },
  'connectors.curated': { zh: 'Forsion 官方收录', en: 'Curated by Forsion' },
  'connectors.toolsTitle': { zh: '工具', en: 'Tools' },
  'connectors.tools': { zh: '工具 · {n}', en: 'Tools · {n}' },
  'connectors.toolsHint': { zh: '默认跟随对话的审批档：「只读」「自动改文件」会先问你，「完全通行」直接执行。', en: 'By default this follows the conversation’s approval mode: Read only and Auto-edit ask first, Full access runs right away.' },
  'connectors.toolsAfterSignIn': { zh: '登录之后在这里列出工具', en: 'Its tools are listed here after you sign in.' },
  'connectors.toolsAfterKey': { zh: '填好 Key、连上之后在这里列出工具', en: 'Its tools are listed here once you add a key and it connects.' },
  'connectors.toolsWhenOff': { zh: '打开开关后在这里列出工具', en: 'Turn it on to list its tools here.' },
  'connectors.moreTools': { zh: '还有 {n} 个工具', en: '{n} more tools' },
  'connectors.approval.follow': { zh: '跟随审批档', en: 'Follows approval mode' },
  'connectors.approval.locked': { zh: '每次都问 · Forsion 设定', en: 'Always asks · set by Forsion' },
  'connectors.lockedHint': { zh: 'Forsion 在目录里把这个工具设成每次都问，「完全通行」档也会问', en: 'Forsion set this tool to always ask, even in Full access.' },
  'connectors.bridgedHint': { zh: '审批卡上的工具名形如 {example}', en: 'Approval cards show tool names like {example}' },
  'connectors.retiredBanner': { zh: 'Forsion 已不再提供这个连接器。它还能用，你可以随时断开；断开后不能再从商店连回来。', en: 'Forsion no longer offers this connector. It still works and you can disconnect any time, but you can’t add it again from the store.' },
  'connectors.emptyTitle': { zh: '还没有连接器', en: 'No connectors yet' },
  'connectors.emptyBody': { zh: '在商店里连上 Notion、Linear、Figma 这类服务后，Agent 就能读写你在里面的内容。', en: 'Connect services like Notion, Linear or Figma in the store and agents can work with your content there.' },
  'connectors.mcpEntry': { zh: '连接器 · {n} 个', en: 'Connectors · {n}' },
  'connectors.mcpEntryHint': { zh: '从商店连上的官方连接器在单独一页管理', en: 'Official connectors from the store are managed on their own page' },
  'connectors.manage': { zh: '已连接 · 管理', en: 'Connected · Manage' },
})

const hostOf = (url?: string): string => { try { return new URL(url || '').host } catch { return '' } }

function ConnectorIcon({ c, size = 24 }: { c: ConnectorEntry; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!c.iconUrl || failed) return <Plug size={size} strokeWidth={1.7} />
  return <img className="mk-icon-img" src={c.iconUrl} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
}

/** 填 Key:旁边链到 applyUrl(去哪申请)。 */
function KeyForm({ c, busy, onSubmit }: { c: ConnectorEntry; busy: boolean; onSubmit: (key: string) => void }) {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  return (
    <form className="conn-keyform" data-connector-keyform={c.id} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (key.trim()) onSubmit(key) }}>
      <input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={t('connectors.keyPlaceholder')} onChange={(e) => setKey(e.target.value)} />
      <button type="submit" className="btn sm primary" disabled={busy || !key.trim()}><KeyRound size={13} />{t('connectors.keySave')}</button>
      {c.auth?.applyUrl && <button type="button" className="btn sm ghost" onClick={() => void window.tangu?.openExternal?.(c.auth!.applyUrl)}><ExternalLink size={12} />{t('connectors.keyApply')}</button>}
      <small>{t('connectors.keyHint')}</small>
    </form>
  )
}

/** 连接 / 登录 / 填 Key 的结果 → 一句话(由调用方的提示条显示)。needs-key 时返回 null:界面直接出填 Key 表单。 */
function useResultText() {
  const { t } = useI18n()
  return (r: ConnectResult, label: string): { text: string; error: boolean } | null =>
    r.kind === 'connected' ? { text: t('connectors.nowConnected', { name: label }), error: false }
      : r.kind === 'browser' ? { text: t('connectors.browserOpened', { name: label }), error: false }
        : r.kind === 'pending' ? { text: t('connectors.pending'), error: true }
          : r.kind === 'error' ? { text: `${t('connectors.failed', { name: label })}${r.message}`, error: true }
            : null
}

/** 商店「连接器」分类。只列已发布的远端 MCP 型;下线的不再显示、不能新连(已连上的在设置页)。 */
export function ConnectorStore({ query, onNotice }: { query: string; onNotice: (n: { text: string; error: boolean } | null) => void }) {
  const { t, locale } = useI18n()
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [rows, setRows] = useState<Map<string, McpRow>>(new Map())
  const [busy, setBusy] = useState<Record<string, true>>({})
  const [askKey, setAskKey] = useState<Record<string, string>>({}) // id → server 名
  const waiting = useRef(new Map<string, string>()) // 等浏览器那头的:id → 名字
  const resultText = useResultText()

  const load = useCallback(() => {
    setLoadError(false)
    window.tangu!.connectorsList!(true).then(setCatalog).catch(() => setLoadError(true))
  }, [])
  const refreshRows = useCallback(() => connectorRows().then(setRows).catch(() => {}), [])
  useEffect(() => { load(); void refreshRows() }, [load, refreshRows])
  // 等浏览器登录 / 后台连接的期间轮询状态:连上了就换成「已连接」并说一声
  useEffect(() => {
    const timer = setInterval(() => {
      if (!waiting.current.size && !Object.keys(busy).length) return
      void connectorRows().then((next) => {
        setRows(next)
        for (const [id, label] of waiting.current) {
          if (next.get(id)?.status === 'connected') { waiting.current.delete(id); onNotice({ text: t('connectors.nowConnected', { name: label }), error: false }) }
        }
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [busy, onNotice, t])

  const run = async (c: ConnectorEntry, step: () => Promise<ConnectResult>): Promise<void> => {
    const label = connectorName(c, locale)
    setBusy((m) => ({ ...m, [c.id]: true }))
    onNotice(null)
    try {
      const r = await step()
      if (r.kind === 'needs-key') setAskKey((m) => ({ ...m, [c.id]: r.name }))
      else setAskKey((m) => { const n = { ...m }; delete n[c.id]; return n })
      if (r.kind === 'browser') waiting.current.set(c.id, label)
      const msg = resultText(r, label)
      if (msg) onNotice(msg)
      else if (r.kind === 'needs-key' && askKey[c.id]) onNotice({ text: t('connectors.keyRejected'), error: true })
    } catch (e) {
      onNotice({ text: `${t('connectors.failed', { name: label })}${e instanceof Error ? e.message : String(e)}`, error: true })
    } finally {
      setBusy((m) => { const n = { ...m }; delete n[c.id]; return n })
      void refreshRows()
    }
  }

  if (!catalog && !loadError) return <Skeleton variant="list" />
  const needle = query.trim().toLocaleLowerCase()
  const shown = (catalog?.connectors ?? [])
    .filter((c) => c.status === 'published' && c.kind === 'remote-mcp')
    .filter((c) => !needle || [c.id, c.name.zh, c.name.en, c.description.zh, c.description.en].some((v) => v.toLocaleLowerCase().includes(needle)))
  if (!shown.length) {
    return (
      <div className="mk-state-card">
        <Plug size={28} />
        <strong>{loadError || (catalog?.offline && !catalog.connectors.length) ? t('connectors.loadFailed') : query ? t('market.noResults') : t('connectors.empty')}</strong>
        {(loadError || catalog?.offline) && <button className="btn sm" onClick={load}>{t('connectors.retry')}</button>}
      </div>
    )
  }
  return (
    <div className="mk-webapps" data-connector-store>
      {catalog?.offline && <p className="mk-web-hint">{t('connectors.offline')}</p>}
      <div className="mk-grid">
        {shown.map((c) => {
          const row = rows.get(c.id)
          const label = connectorName(c, locale)
          const isBusy = !!busy[c.id]
          const keyFor = askKey[c.id] ?? (row?.auth === 'user-key' && row.status === 'needs-login' ? row.server : undefined)
          const oauthLogin = row && row.auth !== 'user-key' && (row.status === 'needs-login' || row.status === 'logging-in')
          return (
            <article key={c.id} className="mk-card" data-connector={c.id} data-connector-state={row?.status ?? 'none'}>
              <div className="mk-card-visual"><ConnectorIcon c={c} /></div>
              <div className="mk-card-content">
                <div className="mk-card-eyeline"><span>{t('connectors.tab')}</span></div>
                <div className="mk-card-title">{label}</div>
                <div className="mk-card-summary">{connectorDescription(c, locale)}</div>
                {keyFor && <KeyForm c={c} busy={isBusy} onSubmit={(key) => void run(c, () => submitConnectorKey(keyFor, key))} />}
                <div className="mk-card-foot">
                  <span className="mk-card-meta" title={c.url?.split('?')[0]}>{hostOf(c.url)}</span>
                  {row?.status === 'connected'
                    ? <button className="btn sm" data-connector-action="manage" onClick={() => useApp.getState().openSettings(`connectors/conn:${row.server}`)}>{t('connectors.manage')} <ChevronRight size={13} /></button>
                    : keyFor ? null
                      : <button className="btn sm primary" disabled={isBusy} data-connector-action={oauthLogin ? 'login' : 'connect'} onClick={() => void run(c, () => connectConnector(c))}>
                        {isBusy ? t('connectors.connecting') : oauthLogin ? <><LogIn size={13} />{t('connectors.signIn')}</> : <><Plug size={13} />{t('connectors.connect')}</>}
                      </button>}
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

/** 设置 → 连接器页(连接器设置方案 A,2026-11-02):已连接的列表 → 单个连接器的详情(状态 / 登录或 Key / 权限 / 工具)。
 *  自己读 mcp.json 与引擎状态并轮询;MCP 页只留一行入口。审批下拉要等引擎按工具的设置(方案第二步),这一步工具行只显示「跟随审批档」或目录锁定的「每次都问」。 */
export function ConnectorSettingsPage({ initialServer, onOpenMcp }: { initialServer?: string; onOpenMcp?: () => void }) {
  const { t, locale } = useI18n()
  const [servers, setServers] = useState<Record<string, McpServerConfigEntry> | null>(null)
  const [rows, setRows] = useState<McpRow[] | null>(null)
  const [catalog, setCatalog] = useState<ConnectorEntry[]>([])
  const [selected, setSelected] = useState<string | null>(initialServer ?? null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [keyOpen, setKeyOpen] = useState<string | null>(null)
  const [allTools, setAllTools] = useState(false)
  const resultText = useResultText()

  const refresh = useCallback(() => {
    void window.tangu?.readMcpConfig?.().then((c) => setServers(c.mcpServers)).catch(() => setServers({}))
    void listTools(homeTarget()).then((r) => setRows(r.mcp ?? [])).catch(() => setRows([]))
  }, [])
  useEffect(() => {
    void window.tangu?.connectorsList?.(false).then((c) => setCatalog(c.connectors)).catch(() => {})
    refresh()
    const timer = setInterval(refresh, 2000) // 浏览器那头登录完、引擎重连都靠轮询看到
    return () => clearInterval(timer)
  }, [refresh])
  /** 进详情:顺带决定填 Key 表单开不开(列表行的「填写 Key」直接开着进)。 */
  const open = (name: string | null, withKey = false): void => { setSelected(name); setAllTools(false); setKeyOpen(withKey ? name : null); setNotice(null) }

  const say = (text: string, error = false): void => setNotice({ text, error })
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  const mine = Object.entries(servers ?? {}).filter(([, sc]) => typeof sc.connector === 'string')
  const items = mine.map(([name, sc]) => {
    const c = catalog.find((x) => x.id === sc.connector)
    const row = rows?.find((r) => r.server === name && !r.origin)
    const label = c ? connectorName(c, locale) : name
    const off = sc.enabled === false
    const attention = !off && !!row && ['needs-login', 'error'].includes(row.status)
    return { name, sc, c, row, label, off, attention }
  }).sort((a, b) => Number(!!b.attention) - Number(!!a.attention)
    || Number(a.c?.status === 'retired') - Number(b.c?.status === 'retired')
    || (a.c?.order ?? 1e9) - (b.c?.order ?? 1e9) || a.label.localeCompare(b.label))

  const statusLabel = (it: typeof items[number]): string =>
    it.off ? t('settings.mcp.statusDisabled')
      : !it.row ? t('connectors.statusPending')
        : it.row.status === 'connected' ? t('connectors.statusConnected', { n: it.row.tools.length })
          : it.row.status === 'needs-login' ? t(it.row.auth === 'user-key' ? 'connectors.statusNeedsKey' : 'connectors.statusNeedsLogin')
            : it.row.status === 'logging-in' ? t('connectors.statusLoggingIn')
              : it.row.status === 'connecting' ? t('connectors.statusConnecting')
                : it.row.status === 'disabled' ? t('settings.mcp.statusDisabled')
                  : t('connectors.statusError')
  const dot = (it: typeof items[number]): string => (it.off ? '' : it.row?.status === 'connected' ? 'ok' : it.row?.status === 'error' ? 'err' : '')
  const act = async (name: string, step: () => Promise<void>): Promise<void> => {
    setBusy(name); setNotice(null)
    try { await step() } catch (e) { say(`${t('settings.toast.saveFailed')}${errText(e)}`, true) } finally { setBusy(null); refresh() }
  }
  const login = (it: typeof items[number]): Promise<void> => act(it.name, async () => {
    const m = resultText(await loginConnector(it.name), it.label)
    if (m) say(m.text, m.error)
  })
  const saveKey = (it: typeof items[number], key: string): Promise<void> => act(it.name, async () => {
    const r = await submitConnectorKey(it.name, key)
    if (r.kind === 'needs-key') { say(t('connectors.keyRejected'), true); return }
    setKeyOpen(null)
    const m = resultText(r, it.label)
    if (m) say(m.text, m.error)
  })
  const signOut = (it: typeof items[number]): void => {
    if (!window.confirm(t('settingsmodal.mcp.logoutConfirm', { name: it.label }))) return
    void act(it.name, async () => { await mcpLogout(homeTarget(), it.name); say(t('settingsmodal.mcp.loggedOut', { name: it.label })) })
  }
  const disconnect = (it: typeof items[number]): void => {
    if (!window.confirm(t('connectors.disconnectConfirm', { name: it.label }))) return
    void act(it.name, async () => { await disconnectConnector(it.name); open(null); say(t('connectors.disconnected', { name: it.label })) })
  }
  const setEnabled = (it: typeof items[number], on: boolean): Promise<void> => act(it.name, async () => {
    const next = await window.tangu!.writeMcpConfig!({ mcpServers: { ...servers, [it.name]: { ...it.sc, enabled: on } }, base: servers ?? {} })
    setServers(next.mcpServers)
    say(t(on ? 'settings.mcp.enabledMsg' : 'settings.mcp.disabledMsg'))
  })
  const quickAction = (it: typeof items[number]): React.ReactNode => {
    if (it.off || it.row?.status !== 'needs-login') return null
    const key = it.row.auth === 'user-key'
    return (
      <button className="btn sm" disabled={busy === it.name} data-connector-quick={it.sc.connector}
        onClick={(e) => { e.stopPropagation(); if (key) open(it.name, true); else void login(it) }}>
        {key ? <><KeyRound size={13} />{t('connectors.enterKey')}</> : <><LogIn size={13} />{t('connectors.signIn')}</>}
      </button>
    )
  }
  const noticeLine = notice && <p className={`hint conn-notice${notice.error ? ' is-error' : ''}`} role="status">{notice.text}</p>

  if (!servers || !rows) return <Skeleton variant="list" />
  const it = selected ? items.find((x) => x.name === selected) : undefined

  if (!it) {
    const openStore = (): void => useApp.getState().openMarket(undefined, { tab: 'connector', nonce: Date.now() })
    return (
      <div data-connector-settings>
        {noticeLine}
        {items.length === 0 ? (
          <SettingsState icon={<Plug size={20} />} title={t('connectors.emptyTitle')} description={t('connectors.emptyBody')}
            actions={<button className="btn primary sm" data-connector-add onClick={openStore}><Store size={13} />{t('connectors.addFromStore')}</button>} />
        ) : (
          <SettingsPanel icon={<Plug size={16} />} title={t('connectors.connectedCount', { n: items.length })} description={t('connectors.openRowHint')}
            actions={<button className="btn sm" data-connector-add onClick={openStore}><Store size={13} />{t('connectors.addFromStore')}</button>}>
            {items.map((x) => (
              <div key={x.name} className="settings-control-row settings-setting-row conn-list-row" role="button" tabIndex={0} data-connector-row={x.sc.connector}
                onClick={() => open(x.name)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x.name) } }}>
                <div className="settings-control-copy conn-list-copy">
                  <span className="conn-logo">{x.c ? <ConnectorIcon c={x.c} size={18} /> : <Plug size={18} />}</span>
                  <span>
                    <strong>{x.label}{x.c?.status === 'retired' && <span className="conn-badge">{t('connectors.retired')}</span>}</strong>
                    <small>{hostOf(x.c?.url ?? x.sc.url)}</small>
                  </span>
                </div>
                <div className="settings-row-control conn-list-control">
                  <span className="conn-status" title={x.row?.error || undefined}><span className={`settings-status-dot ${dot(x)}`} />{statusLabel(x)}</span>
                  {quickAction(x)}
                  <ChevronRight size={15} className="conn-chevron" aria-hidden="true" />
                </div>
              </div>
            ))}
          </SettingsPanel>
        )}
        <p className="hint conn-foot">
          {t('connectors.manualHint')}
          {onOpenMcp && <> <button type="button" className="conn-link" onClick={onOpenMcp}>{t('settingsmodal.tab.mcp')} ›</button></>}
        </p>
      </div>
    )
  }

  const { c, row, sc, label, off } = it
  const keyType = row?.auth === 'user-key' || c?.auth?.type === 'user-key'
  const host = hostOf(c?.url ?? sc.url)
  const locked = new Set(c?.alwaysAsk ?? [])
  const tools = row?.status === 'connected' && !off ? row.tools : []
  const TOOL_PREVIEW = 8
  const shownTools = allTools ? tools : tools.slice(0, TOOL_PREVIEW)
  const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const isBusy = busy === it.name

  // 开关跟配置走、任何状态都在:连不上的服务要能先停掉,不必断开(断开会删登录 / Key)。关了再开 = 立刻重连一次。
  const toggle = <SettingsSwitch checked={!off} label={t(off ? 'settings.mcp.enable' : 'settings.mcp.disable')} disabled={isBusy} onChange={(on) => void setEnabled(it, on)} data-connector-enabled />
  const statusRow = (description: React.ReactNode, action?: React.ReactNode) => (
    <SettingsRow label={t('connectors.status')} fit="inline" description={description} control={<>{action}{toggle}</>} />
  )
  const status = off ? statusRow(t('connectors.disabledHint'))
    : row?.status === 'connected'
      ? statusRow(<>{statusLabel(it)}{typeof row.approxTokens === 'number' && <> · {t('connectors.tokens', { n: fmtTok(row.approxTokens) })}</>}</>)
      : row?.status === 'needs-login'
        ? statusRow(t(keyType ? 'connectors.noKeyYet' : 'connectors.notSignedIn'),
          keyType ? null : <button className="btn sm primary" disabled={isBusy} data-connector-login onClick={() => void login(it)}><LogIn size={13} />{t('connectors.signIn')}</button>)
        : row?.status === 'logging-in'
          ? statusRow(t('connectors.loggingInHint', { host }), <button className="btn sm ghost" disabled={isBusy} onClick={() => void login(it)}><ExternalLink size={12} />{t('connectors.reopen')}</button>)
          : row?.status === 'error'
            ? statusRow(<span className="conn-error">{t('connectors.statusError')}{row.error ? `:${row.error}` : ''}</span>)
            : statusRow(statusLabel(it))

  return (
    <div data-connector-settings data-connector-detail={sc.connector}>
      <button type="button" className="btn ghost sm conn-back" data-connector-back onClick={() => open(null)}><ChevronLeft size={14} />{t('connectors.allConnectors')}</button>
      {noticeLine}
      <SettingsPanel className="conn-detail"
        icon={c ? <ConnectorIcon c={c} size={20} /> : <Plug size={16} />}
        title={<>{label}{c?.status === 'retired' && <span className="conn-badge">{t('connectors.retired')}</span>}</>}
        description={<><span title={(c?.url ?? sc.url ?? '').split('?')[0]}>{host}</span> · {t('connectors.curated')}</>}
        actions={<button className="btn sm ghost conn-danger" disabled={isBusy} data-connector-disconnect={sc.connector} onClick={() => disconnect(it)}><Unplug size={13} />{t('connectors.disconnect')}</button>}>
        {c?.status === 'retired' && <div className="settings-control-row conn-retired"><Info size={14} />{t('connectors.retiredBanner')}</div>}
        {status}
        {keyType
          ? <SettingsRow label="Key" fit="wrap" description={row?.status === 'connected' ? t('connectors.keySaved') : t('connectors.keyMissing')}
            control={keyOpen === it.name || off ? null : <button className="btn sm ghost" disabled={isBusy} data-connector-key onClick={() => setKeyOpen(it.name)}><KeyRound size={13} />{t(row?.status === 'connected' ? 'connectors.changeKey' : 'connectors.enterKey')}</button>}>
            {keyOpen === it.name && !off && c && <KeyForm c={c} busy={isBusy} onSubmit={(key) => void saveKey(it, key)} />}
          </SettingsRow>
          : row?.signedIn
            ? <SettingsRow label={t('connectors.signInRow')} fit="wrap" description={t('connectors.signedInOAuth', { name: label })}
              control={<>{!off && <button className="btn sm ghost" disabled={isBusy} onClick={() => void login(it)}><LogIn size={13} />{t('connectors.signInAgain')}</button>}
                <button className="btn sm ghost" disabled={isBusy} data-connector-signout onClick={() => signOut(it)}><LogOut size={13} />{t('connectors.signOut')}</button></>} />
            : null}
        {!keyType && (
          <SettingsRow label={t('connectors.access')}
            description={c?.oauth?.scopes?.length
              ? <span className="conn-scope-tags">{c.oauth.scopes.map((x) => <span key={x} className="model-tag" data-color="gray">{x}</span>)}</span>
              : t('connectors.accessByConsent', { name: label })} />
        )}
      </SettingsPanel>
      <SettingsPanel icon={<Wrench size={16} />} title={tools.length ? t('connectors.tools', { n: tools.length }) : t('connectors.toolsTitle')}
        description={tools.length ? t('connectors.toolsHint') : undefined}>
        {tools.length === 0
          ? <div className="settings-control-row conn-tools-empty">{t(off ? 'connectors.toolsWhenOff' : keyType ? 'connectors.toolsAfterKey' : 'connectors.toolsAfterSignIn')}</div>
          : shownTools.map((tool) => {
            const remote = tool.remoteName ?? tool.name
            const desc = tool.description.replace(/^\[MCP·[^\]]*\]\s*/, '') // 引擎给模型加的来源前缀,这里已经在连接器页里了
            return (
              <div key={tool.name} className="settings-control-row settings-setting-row conn-tool" data-connector-tool={remote}>
                <div className="settings-control-copy"><span><strong className="conn-tool-name">{remote}</strong>{desc && <small title={desc}>{desc}</small>}</span></div>
                <div className="settings-row-control conn-tool-approval">
                  {locked.has(remote)
                    ? <span className="conn-locked" title={t('connectors.lockedHint')} data-connector-locked><Lock size={12} />{t('connectors.approval.locked')}</span>
                    : <span className="conn-follow">{t('connectors.approval.follow')}</span>}
                </div>
              </div>
            )
          })}
        {tools.length > TOOL_PREVIEW && !allTools && (
          <button type="button" className="settings-control-row conn-more" onClick={() => setAllTools(true)}>{t('connectors.moreTools', { n: tools.length - TOOL_PREVIEW })}<ChevronDown size={12} /></button>
        )}
      </SettingsPanel>
      {tools[0] && <p className="hint conn-foot">{t('connectors.bridgedHint', { example: tools[0].name })}</p>}
    </div>
  )
}
