/**
 * 设置 → 通道(Channels):微信 / Telegram / QQ 一卡一通道。
 * 布局:卡头 = 图标 + 名称 + 状态点 + 启用开关(不展开也能启停);卡体 = 凭据/扫码 + 每通道默认
 * (Agent / LLM / 画图 / 语音模型 / 审批)+ 通道会话开关 + 收件箱转发(与会话独立)。
 * 刻意不展示历史绑定列表(旧版乱源);连接语义 = 连接即新会话。
 */
import React, { useEffect, useState } from 'react'
import { MessageCircle, Send, MessagesSquare, Loader2, RefreshCw } from 'lucide-react'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { useChannels, type ChannelStatus } from '../stores/channelsStore'
import { startWechatLogin, pollWechatLogin, type ChannelConfigPatch } from '../services/backendService'
import { QrImage } from './QrImage'
import type { ChannelKind, TanguDesktopConfig } from '../types'
import { SettingsState } from './SettingsPrimitives'

const ICONS: Record<ChannelKind, React.ReactNode> = {
  wechat: <MessageCircle size={16} />,
  telegram: <Send size={16} />,
  qq: <MessagesSquare size={16} />,
}

const KINDS: ChannelKind[] = ['wechat', 'telegram', 'qq']

export function ChannelsTab(p: { cfg: TanguDesktopConfig }) {
  const { t } = useI18n()
  const channels = useChannels((s) => s.channels)
  const available = useChannels((s) => s.available)
  const loaded = useChannels((s) => s.loaded)
  const agentDefs = useApp((s) => s.agentDefs)
  const modelsResp = useApp((s) => s.modelsResp)
  const [expanded, setExpanded] = useState<ChannelKind | null>(null)
  const [busy, setBusy] = useState<Partial<Record<ChannelKind, boolean>>>({})
  const [msg, setMsg] = useState<Partial<Record<ChannelKind, string>>>({})
  // 凭据输入暂存(已保存的 secret 不回显,placeholder 提示已保存;输入后 onBlur 提交)。
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [qr, setQr] = useState<{ loginId: string; img: string; status: string } | null>(null)

  useEffect(() => { void useChannels.getState().refresh() }, [])

  // 微信扫码轮询(2s;confirmed/expired 收尾)。
  useEffect(() => {
    if (!qr) return
    let canceled = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const r = await pollWechatLogin(p.cfg, qr.loginId)
          if (canceled) return
          if (r.status === 'confirmed') {
            setQr(null)
            setMsg((m) => ({ ...m, wechat: t('channels.connectedMsg') }))
            await useChannels.getState().refresh()
            void useApp.getState().refreshSessions(p.cfg)
          } else if (r.status === 'expired' || r.status === 'failed') {
            setQr(null)
            setMsg((m) => ({ ...m, wechat: r.detail || t('channels.qrExpired') }))
          } else {
            setQr((cur) => (cur && cur.loginId === qr.loginId ? { ...cur, status: r.status } : cur))
          }
        } catch (e: any) {
          if (canceled) return
          setQr(null)
          setMsg((m) => ({ ...m, wechat: t('channels.connectFailed', { e: e?.message || e }) }))
        }
      })()
    }, 2000)
    return () => { canceled = true; window.clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr?.loginId])

  const withBusy = async (kind: ChannelKind, fn: () => Promise<void>): Promise<void> => {
    setBusy((b) => ({ ...b, [kind]: true }))
    setMsg((m) => ({ ...m, [kind]: '' }))
    try {
      await fn()
    } catch (e: any) {
      setMsg((m) => ({ ...m, [kind]: t('channels.connectFailed', { e: e?.message || e }) }))
    } finally {
      setBusy((b) => ({ ...b, [kind]: false }))
    }
  }

  const save = (kind: ChannelKind, patch: ChannelConfigPatch) => void withBusy(kind, async () => {
    await useChannels.getState().save(kind, patch)
  })

  const doConnect = (ch: ChannelStatus) => void withBusy(ch.kind, async () => {
    if (ch.kind === 'wechat') {
      if (!ch.enabled) await useChannels.getState().save('wechat', { enabled: true })
      const r = await startWechatLogin(p.cfg, { approval_mode: ch.approvalMode })
      setQr({ loginId: r.loginId, img: r.qrcodeImg, status: 'pending' })
    } else {
      const r = await useChannels.getState().connect(ch.kind)
      setMsg((m) => ({ ...m, [ch.kind]: t('channels.connectedAs', { label: r.label || '' }) }))
    }
  })

  const doDisconnect = (ch: ChannelStatus) => void withBusy(ch.kind, async () => {
    // 微信按「活跃绑定的账号」断开(iLink 可存多账号,runtime[0] 未必是活跃那个)。
    const accountId = ch.kind === 'wechat' ? (ch.accountId || ch.runtime[0]?.accountId) : undefined
    await useChannels.getState().disconnect(ch.kind, accountId)
    setMsg((m) => ({ ...m, [ch.kind]: t('channels.disconnected') }))
  })

  // 收件箱转发 senders 的全量候选(agent slugs + 系统 + 云端)。
  const senderOptions: Array<{ id: string; label: string }> = [
    ...agentDefs.map((a) => ({ id: a.slug, label: a.name || a.slug })),
    { id: 'system', label: t('channels.senderSystem') },
    { id: 'server', label: t('channels.senderServer') },
  ]

  const toggleSender = (ch: ChannelStatus, id: string) => {
    const cur = ch.inboxForward.senders
    let next: 'all' | string[]
    if (cur === 'all') next = senderOptions.map((o) => o.id).filter((x) => x !== id) // 从全量里减去该项
    else next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    save(ch.kind, { inboxForward: { enabled: ch.inboxForward.enabled, senders: next } })
  }

  const llmModels = (modelsResp?.models || []).filter((m) => !m.modelType || m.modelType === 'llm')
  const imageModels = (modelsResp?.models || []).filter((m) => m.modelType === 'image_gen')

  const statusOf = (ch: ChannelStatus): { on: boolean; text: string } => {
    if (!ch.enabled) return { on: false, text: t('channels.status.disabled') }
    const running = ch.runtime.some((r) => r.running)
    const label = ch.runtime.find((r) => r.label)?.label
    return running
      ? { on: true, text: label ? `${t('channels.status.connected')} · ${label}` : t('channels.status.connected') }
      : { on: false, text: t('channels.status.notConnected') }
  }

  if (!loaded) return <SettingsState icon={<Loader2 size={19} />} title={t('channels.loadingTitle')} description={t('channels.loadingHint')} busy />
  if (!available) return (
    <SettingsState
      icon={<MessageCircle size={19} />}
      title={t('channels.notAvailable')}
      description={t('channels.notAvailableHint')}
      actions={<button className="btn ghost sm" onClick={() => void useChannels.getState().refresh()}><RefreshCw size={12} />{t('common.refresh')}</button>}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="hint">{t('channels.intro')}</div>
      {KINDS.map((kind) => {
        const ch = channels.find((c) => c.kind === kind)
        if (!ch) return null
        const st = statusOf(ch)
        const open = expanded === kind
        const isBusy = !!busy[kind]
        // 已绑定 = 有活跃绑定(connectedSessionId);peerBound=false 只表示还没等到第一条消息,不该再显示「连接」。
        const bound = ch.enabled && !!ch.connectedSessionId
        return (
          <div key={kind} className="field chan-card">
            <button type="button" className="chan-head" onClick={() => setExpanded(open ? null : kind)}>
              {ICONS[kind]}
              <span className="chan-name">{t(`channel.name.${kind}`)}</span>
              <span className="chan-status">
                <span className={`mini-dot${st.on ? ' ok' : ''}`} />
                {st.text}
              </span>
              <label className="chan-switch" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  disabled={isBusy}
                  onChange={(e) => save(kind, { enabled: e.target.checked })}
                />
                {t('channels.enable')}
              </label>
            </button>
            {open && (
              <div className="chan-body">
                {/* ── 连接 ── */}
                {kind === 'telegram' && (
                  <div className="chan-row">
                    <label>{t('channels.botToken')}</label>
                    <input
                      type="password"
                      style={{ flex: 1, minWidth: 180 }}
                      value={creds['tg.token'] ?? ''}
                      placeholder={ch.credentials.botTokenSet ? t('channels.secretSaved') : '123456:ABC-DEF…'}
                      onChange={(e) => setCreds((c) => ({ ...c, 'tg.token': e.target.value }))}
                      onBlur={() => {
                        const v = (creds['tg.token'] || '').trim()
                        if (v) { save(kind, { botToken: v }); setCreds((c) => ({ ...c, 'tg.token': '' })) }
                      }}
                    />
                  </div>
                )}
                {kind === 'qq' && (
                  <>
                    <div className="chan-row">
                      <label>AppID</label>
                      <input
                        style={{ flex: 1, minWidth: 140 }}
                        value={creds['qq.id'] ?? ch.credentials.appId}
                        onChange={(e) => setCreds((c) => ({ ...c, 'qq.id': e.target.value }))}
                        onBlur={() => {
                          const v = (creds['qq.id'] || '').trim()
                          if (v && v !== ch.credentials.appId) save(kind, { appId: v })
                        }}
                      />
                      <label>AppSecret</label>
                      <input
                        type="password"
                        style={{ flex: 1, minWidth: 140 }}
                        value={creds['qq.secret'] ?? ''}
                        placeholder={ch.credentials.appSecretSet ? t('channels.secretSaved') : ''}
                        onChange={(e) => setCreds((c) => ({ ...c, 'qq.secret': e.target.value }))}
                        onBlur={() => {
                          const v = (creds['qq.secret'] || '').trim()
                          if (v) { save(kind, { appSecret: v }); setCreds((c) => ({ ...c, 'qq.secret': '' })) }
                        }}
                      />
                    </div>
                    <div className="hint">{t('channels.qqHint')}</div>
                  </>
                )}
                {kind === 'telegram' && <div className="hint">{t('channels.botTokenHint')}</div>}

                <div className="chan-row">
                  {!bound && (
                    <button className="btn sm" disabled={isBusy} onClick={() => doConnect(ch)}>
                      {isBusy ? <Loader2 size={13} className="spin" /> : null}
                      {kind === 'wechat' ? t('channels.scanConnect') : t('channels.connect')}
                    </button>
                  )}
                  {bound && (
                    <button className="btn ghost sm" disabled={isBusy} onClick={() => doDisconnect(ch)}>
                      {t('channels.disconnect')}
                    </button>
                  )}
                  {bound && !ch.peerBound && <span className="hint" style={{ margin: 0 }}>{t('channels.waitingPeer')}</span>}
                  {msg[kind] && <span className="hint" style={{ margin: 0 }}>{msg[kind]}</span>}
                </div>
                {kind === 'wechat' && qr && (
                  <div className="wechat-login-box">
                    <QrImage value={qr.img} size={132} className="wechat-qr" />
                    <div className="hint">{t('channels.scanQrHint')}</div>
                  </div>
                )}
                <div className="hint">{t('channels.newSessionHint')}</div>

                {/* ── 通道会话 ── */}
                <div className="settings-sec settings-sec--gap">{t('channels.sessionsSec')}</div>
                <label className="check-row">
                  <input type="checkbox" checked={ch.sessions} onChange={(e) => save(kind, { sessions: e.target.checked })} />
                  <span>
                    <span className="check-name">{t('channels.sessions')}</span><br />
                    <span className="check-desc">{t('channels.sessionsHint')}</span>
                  </span>
                </label>
                <div className="chan-row">
                  <label>{t('channels.approval')}</label>
                  <select value={ch.approvalMode} onChange={(e) => save(kind, { approvalMode: e.target.value })}>
                    <option value="readonly">{t('channels.approval.readonly')}</option>
                    <option value="auto-edit">{t('channels.approval.autoEdit')}</option>
                    <option value="full-auto">{t('channels.approval.fullAuto')}</option>
                  </select>
                </div>
                <div className="chan-row">
                  <label>{t('channels.defaultAgent')}</label>
                  <select value={ch.agentSlug} onChange={(e) => save(kind, { agentSlug: e.target.value })}>
                    <option value="">{t('channels.followDefault')}</option>
                    {agentDefs.map((a) => <option key={a.slug} value={a.slug}>{a.name || a.slug}</option>)}
                  </select>
                </div>
                <div className="chan-row">
                  <label>{t('channels.defaultModel')}</label>
                  <select value={ch.modelId} onChange={(e) => save(kind, { modelId: e.target.value })}>
                    <option value="">{t('channels.followDefault')}</option>
                    {llmModels.map((m) => <option key={`${m.source}-${m.id}`} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div className="chan-row">
                  <label>{t('channels.imageModel')}</label>
                  <select value={ch.imageModelId} onChange={(e) => save(kind, { imageModelId: e.target.value })}>
                    <option value="">{t('channels.followGlobal')}</option>
                    {imageModels.map((m) => <option key={`${m.source}-${m.id}`} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div className="chan-row">
                  <label>{t('channels.ttsModel')}</label>
                  <input
                    style={{ flex: 1, minWidth: 140 }}
                    value={creds[`${kind}.tts`] ?? ch.ttsModelId}
                    placeholder={t('channels.ttsModelPlaceholder')}
                    onChange={(e) => setCreds((c) => ({ ...c, [`${kind}.tts`]: e.target.value }))}
                    onBlur={() => {
                      const v = creds[`${kind}.tts`]
                      if (v !== undefined && v.trim() !== ch.ttsModelId) save(kind, { ttsModelId: v.trim() })
                    }}
                  />
                  <label>{t('channels.ttsVoice')}</label>
                  <input
                    style={{ width: 110 }}
                    value={creds[`${kind}.voice`] ?? ch.ttsVoice}
                    onChange={(e) => setCreds((c) => ({ ...c, [`${kind}.voice`]: e.target.value }))}
                    onBlur={() => {
                      const v = creds[`${kind}.voice`]
                      if (v !== undefined && v.trim() !== ch.ttsVoice) save(kind, { ttsVoice: v.trim() })
                    }}
                  />
                </div>

                {/* ── 收件箱转发(与通道会话独立) ── */}
                <div className="settings-sec settings-sec--gap">{t('channels.forwardSec')}</div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={ch.inboxForward.enabled}
                    onChange={(e) => save(kind, { inboxForward: { enabled: e.target.checked, senders: ch.inboxForward.senders } })}
                  />
                  <span>
                    <span className="check-name">{t('channels.forward')}</span><br />
                    <span className="check-desc">{t('channels.forwardHint')}</span>
                  </span>
                </label>
                {ch.inboxForward.enabled && (
                  <div className="chan-row" style={{ alignItems: 'flex-start' }}>
                    <label style={{ paddingTop: 3 }}>{t('channels.forwardSenders')}</label>
                    <div className="chan-chips">
                      <button
                        className={`chan-chip${ch.inboxForward.senders === 'all' ? ' on' : ''}`}
                        onClick={() => save(kind, { inboxForward: { enabled: true, senders: ch.inboxForward.senders === 'all' ? [] : 'all' } })}
                      >
                        {t('channels.forwardAll')}
                      </button>
                      {senderOptions.map((o) => {
                        const on = ch.inboxForward.senders === 'all' || ch.inboxForward.senders.includes(o.id)
                        return (
                          <button key={o.id} className={`chan-chip${on ? ' on' : ''}`} onClick={() => toggleSender(ch, o.id)}>
                            {o.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
