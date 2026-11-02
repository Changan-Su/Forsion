/**
 * 连接器(连接器方案 2026-10-23「商店与设置页」):商店「连接器」分类的卡片网格 + 设置 → MCP 服务器顶部那一块。
 * 只在桌面出现(window.tangu.connectorsList,宿主声明);目录来自后台,不是市场列表;按钮是「连接 / 已连接」,不是「安装」。
 * 流程见 services/connectorService.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, KeyRound, LogIn, Plug, Store, Unplug } from 'lucide-react'
import { Skeleton } from '@lcl/engine'
import './Connectors.css'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import type { ConnectorCatalog, ConnectorEntry } from '../types'
import {
  connectConnector, connectorDescription, connectorName, connectorRows, disconnectConnector, submitConnectorKey,
  type ConnectResult, type McpRow,
} from '../services/connectorService'

registerMessages({
  'connectors.tab': { zh: '连接器', en: 'Connectors' },
  'connectors.subtitle': { zh: '由 Forsion 官方收录。连接后，Agent 可以用你在这些服务里的数据，登录只保存在这台电脑上', en: 'Curated by Forsion. Once connected, agents can use your data in these services. Sign-ins stay on this computer.' },
  'connectors.connect': { zh: '连接', en: 'Connect' },
  'connectors.connected': { zh: '已连接', en: 'Connected' },
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
  'connectors.section': { zh: '连接器', en: 'Connectors' },
  'connectors.sectionHint': { zh: '从商店连上的官方连接器。断开会删掉这台电脑上保存的登录或 Key', en: 'Official connectors you added from the store. Disconnecting removes the sign-in or key saved on this computer.' },
  'connectors.none': { zh: '还没有连接器', en: 'No connectors yet' },
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
  'connectors.scopes': { zh: '授权范围：{scopes}', en: 'Access: {scopes}' },
  'connectors.disconnect': { zh: '断开', en: 'Disconnect' },
  'connectors.disconnectConfirm': { zh: '断开「{name}」？这台电脑上保存的登录或 Key 会删掉，Agent 也不能再用它', en: 'Disconnect "{name}"? The sign-in or key saved on this computer will be removed and agents can no longer use it.' },
  'connectors.disconnected': { zh: '已断开「{name}」', en: 'Disconnected "{name}"' },
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
                    ? <button className="btn sm" disabled data-connector-action="connected"><Check size={13} />{t('connectors.connected')}</button>
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

/** 设置 → MCP 服务器顶部:已连接的连接器(状态、登录 / 填 Key / 断开)、已下线标记、授权范围,末尾「去商店添加」。 */
export function ConnectorSettingsBlock({ servers, rows, onLogin, onMsg, onChanged }: {
  servers: Record<string, { connector?: string; enabled?: boolean }>
  rows: McpRow[] | undefined
  onLogin: (name: string) => void
  onMsg: (msg: string) => void
  onChanged: () => void
}) {
  const { t, locale } = useI18n()
  const [catalog, setCatalog] = useState<ConnectorEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [keyOpen, setKeyOpen] = useState<string | null>(null)
  useEffect(() => { void window.tangu?.connectorsList?.(false).then((c) => setCatalog(c.connectors)).catch(() => {}) }, [])
  const resultText = useResultText()
  const mine = Object.entries(servers).filter(([, sc]) => typeof sc.connector === 'string')

  const statusLabel = (row: McpRow | undefined): string =>
    !row ? t('connectors.statusPending')
      : row.status === 'connected' ? t('connectors.statusConnected', { n: row.tools.length })
        : row.status === 'needs-login' ? t(row.auth === 'user-key' ? 'connectors.statusNeedsKey' : 'connectors.statusNeedsLogin')
          : row.status === 'logging-in' ? t('connectors.statusLoggingIn')
            : row.status === 'connecting' ? t('connectors.statusConnecting')
              : row.status === 'disabled' ? t('settings.mcp.statusDisabled')
                : t('connectors.statusError')

  const disconnect = async (name: string, label: string): Promise<void> => {
    if (!window.confirm(t('connectors.disconnectConfirm', { name: label }))) return
    setBusy(name)
    try { await disconnectConnector(name); onMsg(t('connectors.disconnected', { name: label })) } catch (e) { onMsg(`${t('settings.toast.saveFailed')}${e instanceof Error ? e.message : String(e)}`) } finally { setBusy(null); onChanged() }
  }
  const saveKey = async (name: string, label: string, key: string): Promise<void> => {
    setBusy(name)
    try {
      const r = await submitConnectorKey(name, key)
      if (r.kind === 'needs-key') onMsg(t('connectors.keyRejected'))
      else { setKeyOpen(null); const m = resultText(r, label); if (m) onMsg(m.text) }
    } catch (e) { onMsg(`${t('connectors.failed', { name: label })}${e instanceof Error ? e.message : String(e)}`) } finally { setBusy(null); onChanged() }
  }

  return (
    <div className="field" data-connector-settings>
      <div className="mcp-settings-heading">
        <label>{t('connectors.section')}</label>
        <div className="mcp-settings-actions"><button className="btn ghost sm" data-connector-add onClick={() => useApp.getState().openMarket(undefined, { tab: 'connector', nonce: Date.now() })}><Store size={13} /> {t('connectors.addFromStore')}</button></div>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>{t('connectors.sectionHint')}</div>
      {mine.length === 0 ? <div className="hint" style={{ marginBottom: 10 }}>{t('connectors.none')}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {mine.map(([name, sc]) => {
            const c = catalog.find((x) => x.id === sc.connector)
            const row = rows?.find((r) => r.server === name)
            const label = c ? connectorName(c, locale) : name
            const needsKey = row?.auth === 'user-key' && row.status === 'needs-login'
            const scopes = c?.oauth?.scopes
            return (
              <div key={name} className="conn-row" data-connector-row={sc.connector}>
                <div className="file-row" style={{ cursor: 'default' }}>
                  <span className="file-name">
                    <b>{label}</b>
                    {c?.status === 'retired' && <span className="conn-badge" title={t('connectors.retiredHint')}>{t('connectors.retired')}</span>}
                    <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 'var(--ui-font-meta, 12px)' }}>{hostOf(c?.url)}</span>
                  </span>
                  <span className="file-size" title={row?.error || undefined}>{sc.enabled === false ? t('settings.mcp.statusDisabled') : statusLabel(row)}</span>
                  {sc.enabled !== false && row && row.auth !== 'user-key' && (row.status === 'needs-login' || row.status === 'logging-in') && (
                    <button className="btn ghost sm" onClick={() => onLogin(name)}><LogIn size={13} /> {t('connectors.signIn')}</button>
                  )}
                  {sc.enabled !== false && needsKey && keyOpen !== name && (
                    <button className="btn ghost sm" onClick={() => setKeyOpen(name)}><KeyRound size={13} /> {t('connectors.enterKey')}</button>
                  )}
                  <button className="icon-btn" title={t('connectors.disconnect')} disabled={busy === name} data-connector-disconnect={sc.connector} onClick={() => void disconnect(name, label)}><Unplug size={13} /></button>
                </div>
                {scopes?.length ? <div className="hint conn-scopes">{t('connectors.scopes', { scopes: scopes.join(', ') })}</div> : null}
                {keyOpen === name && c && <KeyForm c={c} busy={busy === name} onSubmit={(key) => void saveKey(name, label, key)} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
