import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, Trash2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getMasking, setMasking, removeMaskAllow, getMaskLog, type MaskingState, type MaskingSettings, type MaskLogLine } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { useApp } from '../stores/appStore'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { maskKindLabel } from './MaskedValues'
import { formatDateTime } from '../format/time'

registerMessages({
  'maskset.title': { zh: '发给模型之前', en: 'Before sending to a model' },
  'maskset.description': {
    zh: '在这台电脑上把敏感值换成占位符再发出，回复和命令里再换回来。原值不落盘、不上传。',
    en: 'Sensitive values are swapped for placeholders on this computer before sending, and put back in replies and commands. Originals never leave memory.',
  },
  'maskset.secrets': { zh: '遮住密钥和令牌', en: 'Mask keys and tokens' },
  'maskset.secretsHint': { zh: 'API 密钥、私钥、连接串和配置里的密码、Bearer 令牌。', en: 'API keys, private keys, passwords in connection strings and configs, bearer tokens.' },
  'maskset.personal': { zh: '遮住个人信息', en: 'Mask personal info' },
  'maskset.personalHint': { zh: '邮箱、手机号、身份证号、银行卡号（校验位对得上才算）。', en: 'Emails, phone numbers, ID and card numbers (checksums must match).' },
  'maskset.action': { zh: '找到之后', en: 'When found' },
  'maskset.actionHint': { zh: '「拦下」= 这一轮不发，告诉你是哪一处。', en: '“Block” stops the turn and tells you where.' },
  'maskset.action.mask': { zh: '遮住', en: 'Mask' },
  'maskset.action.warn': { zh: '只提醒', en: 'Warn only' },
  'maskset.action.block': { zh: '拦下', en: 'Block' },
  'maskset.allow': { zh: '从不遮住', en: 'Never mask' },
  'maskset.allowHint': { zh: '你正在排查的那把 key 之类，原样发出。在对话里点「遮住 N 个值」加进来。', en: 'Values you want sent as-is, like a key you are debugging. Add them from “values masked” in a chat.' },
  'maskset.manage': { zh: '管理（{n}）', en: 'Manage ({n})' },
  'maskset.allowEmpty': { zh: '还没有。', en: 'None yet.' },
  'maskset.recent': { zh: '最近 7 天', en: 'Last 7 days' },
  'maskset.recentHint': { zh: '遮住 {n} 个值，来自 {m} 个会话。', en: '{n} values masked across {m} chats.' },
  'maskset.recentNone': { zh: '还没有遮住过。记录只留类型、长度和开头 4 个字符，只在这台电脑。', en: 'Nothing masked yet. The log keeps only the kind, length and first 4 characters, on this computer.' },
  'maskset.viewLog': { zh: '查看记录', en: 'View log' },
  'maskset.hideLog': { zh: '收起', en: 'Hide' },
  'maskset.background': { zh: '后台任务', en: 'Background tasks' },
  'maskset.len': { zh: '{n} 个字符', en: '{n} characters' },
  'maskset.warned': { zh: '原样发出', en: 'sent as-is' },
  'maskset.blocked': { zh: '已拦下', en: 'blocked' },
})

/**
 * 设置 → 模型 → 提供方的一节(借鉴 magpie 方案,mask.html「设置放哪」):放在「API 连接」下面,因为它管的就是「发给谁之前」。
 * 引擎 routes/masking.ts;引擎不在这台电脑上(writable=false)整节不显示。开关立即落盘,对下一次请求生效。
 */
export function MaskingSettingsSection() {
  const { t } = useI18n()
  const [state, setState] = useState<MaskingState | null>(null)
  const [open, setOpen] = useState<'allow' | 'log' | null>(null)
  const [log, setLog] = useState<MaskLogLine[] | null>(null)
  const [error, setError] = useState('')
  const sessions = useApp((s) => s.sessions)
  const saving = useRef<Promise<unknown>>(Promise.resolve()) // 连点几下按顺序写,别让先发的回包盖住后发的

  useEffect(() => {
    let alive = true
    getMasking(homeTarget()).then((r) => { if (alive) setState(r) }).catch(() => {})
    return () => { alive = false }
  }, [homeTarget().base])

  if (!state?.writable || !state.settings) return null
  const s = state.settings
  const save = (patch: Partial<MaskingSettings>) => {
    setState((cur) => (cur?.settings ? { ...cur, settings: { ...cur.settings, ...patch } } : cur))
    saving.current = saving.current.then(() => setMasking(homeTarget(), patch)
      .then((settings) => { setState((cur) => (cur ? { ...cur, settings } : cur)); setError('') })
      .catch((e: any) => setError(e?.message || String(e))))
  }
  const toggleLog = () => {
    if (open === 'log') return setOpen(null)
    setOpen('log')
    void getMaskLog(homeTarget()).then(setLog).catch(() => setLog([]))
  }
  const allow = state.allow || []
  const recent = state.recent || { values: 0, sessions: 0 }
  const titleOf = (sid: string) => (sid ? sessions.find((x) => x.id === sid)?.title || sid.slice(0, 8) : t('maskset.background'))
  // 按会话分组,同一会话里同一个值只列一次
  const groups = new Map<string, { t: number; rows: Map<string, MaskLogLine['hits'][number] & { action: MaskLogLine['action'] }> }>()
  for (const l of log || []) {
    const g = groups.get(l.sid) || { t: l.t, rows: new Map() }
    g.t = Math.max(g.t, l.t)
    for (const h of l.hits) g.rows.set(h.ph, { ...h, action: l.action })
    groups.set(l.sid, g)
  }

  return <SettingsPanel icon={<ShieldCheck size={16} />} title={t('maskset.title')} description={t('maskset.description')} anchor="masking">
    <SettingsRow fit="inline" label={t('maskset.secrets')} description={t('maskset.secretsHint')}
      control={<SettingsSwitch checked={s.secrets} label={t('maskset.secrets')} onChange={(v) => save({ secrets: v })} />} />
    <SettingsRow fit="inline" label={t('maskset.personal')} description={t('maskset.personalHint')}
      control={<SettingsSwitch checked={s.personal} label={t('maskset.personal')} onChange={(v) => save({ personal: v })} />} />
    <SettingsRow fit="wrap" label={t('maskset.action')} description={t('maskset.actionHint')}
      control={<div className="seg seg-sm" role="radiogroup" aria-label={t('maskset.action')}>
        {(['mask', 'warn', 'block'] as const).map((a) => <button key={a} type="button" role="radio" aria-checked={s.action === a} className={s.action === a ? 'active' : ''} onClick={() => save({ action: a })}>{t(`maskset.action.${a}`)}</button>)}
      </div>} />
    <SettingsRow fit="inline" label={t('maskset.allow')} description={t('maskset.allowHint')}
      control={<button type="button" className="btn ghost sm" onClick={() => setOpen(open === 'allow' ? null : 'allow')}>{t('maskset.manage', { n: allow.length })}</button>} />
    {open === 'allow' && <div className="mask-settings-list">
      {allow.length ? allow.map((e) => (
        <div key={e.hash} className="mask-settings-item">
          <span>{maskKindLabel(t, e.kind)}</span><small>{t('maskset.len', { n: e.len })} · {formatDateTime(e.at)}</small><span className="grow" />
          <button type="button" className="icon-btn" aria-label={`${t('settings.btn.delete')} · ${maskKindLabel(t, e.kind)}`}
            onClick={() => void removeMaskAllow(homeTarget(), e.hash).then((list) => setState((cur) => (cur ? { ...cur, allow: list } : cur)))}><Trash2 size={13} /></button>
        </div>
      )) : <div className="hint">{t('maskset.allowEmpty')}</div>}
    </div>}
    <SettingsRow fit="inline" label={t('maskset.recent')} description={recent.values ? t('maskset.recentHint', { n: recent.values, m: recent.sessions }) : t('maskset.recentNone')}
      control={<button type="button" className="btn ghost sm" onClick={toggleLog}>{t(open === 'log' ? 'maskset.hideLog' : 'maskset.viewLog')}</button>} />
    {open === 'log' && log && <div className="mask-settings-list">
      {groups.size ? [...groups.entries()].sort((a, b) => b[1].t - a[1].t).map(([sid, g]) => (
        <div key={sid || '-'} className="mask-settings-group">
          <div className="mask-settings-group-head"><strong>{titleOf(sid)}</strong><small>{formatDateTime(g.t)}</small></div>
          {[...g.rows.values()].map((h) => (
            <div key={h.ph} className="mask-settings-item">
              <span>{maskKindLabel(t, h.kind)}</span><code>{h.head}••••</code><small>{t('maskset.len', { n: h.len })}</small>
              {h.action !== 'mask' && <small>· {t(h.action === 'warn' ? 'maskset.warned' : 'maskset.blocked')}</small>}
            </div>
          ))}
        </div>
      )) : <div className="hint">{t('maskset.recentNone')}</div>}
    </div>}
    {error && <div className="hint model-catalog-error" role="alert">{error}</div>}
  </SettingsPanel>
}
