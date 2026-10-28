/**
 * 发给模型前脱敏的对话侧呈现(借鉴 magpie 方案 A,docs/ToBeImproved/借鉴magpie方案_2026-10-28/mask.html):
 * 工具组标题后一句「发给模型前遮住 N 个值」,点开是对照表;展开后被遮的值垫一层主题色底(不画框、不加下划线),悬停说模型收到的是什么。
 * 本机看到的始终是真值。位置由引擎在 tool_result 上给(ToolEvent.masked,不含原值),值从手里的参数 / 结果按位置取。
 */
import React, { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'
import { addMaskAllow } from '../services/backendService'
import { targetForSession } from '../services/engine/targets'
import { useApp } from '../stores/appStore'

registerMessages({
  'mask.tag': { zh: '发给模型前遮住 {n} 个值', en: '{n} values masked before sending' },
  'mask.tag1': { zh: '发给模型前遮住 1 个值', en: '1 value masked before sending' },
  'mask.got': { zh: '模型收到的是 {ph}', en: 'The model got {ph}' },
  'mask.warnTag': { zh: '{n} 个敏感值原样发给了模型', en: '{n} sensitive values sent as-is' },
  'mask.warnTag1': { zh: '1 个敏感值原样发给了模型', en: '1 sensitive value sent as-is' },
  'mask.gotRaw': { zh: '原样发给了模型（只提醒）', en: 'Sent to the model as-is (warn only)' },
  'mask.sentAsIs': { zh: '原样', en: 'As-is' },
  'mask.popTitle': { zh: '这一轮发给模型提供方之前', en: 'Before this turn went to the provider' },
  'mask.col.kind': { zh: '类型', en: 'Kind' },
  'mask.col.local': { zh: '本机（只在这台电脑）', en: 'On this computer' },
  'mask.col.sent': { zh: '模型收到的', en: 'What the model got' },
  'mask.putBack': { zh: '回复和命令里的占位符会换回真值', en: 'Placeholders in replies and commands are put back' },
  'mask.neverMask': { zh: '从不遮住…', en: 'Never mask…' },
  'mask.neverMaskThis': { zh: '从不遮住', en: 'Never mask' },
  'mask.neverMasked': { zh: '下一轮起原样发出', en: 'Sent as-is from the next turn' },
  'mask.settings': { zh: '设置', en: 'Settings' },
  'mask.kind.API_KEY': { zh: 'API 密钥', en: 'API key' },
  'mask.kind.TOKEN': { zh: '令牌', en: 'Token' },
  'mask.kind.PASSWORD': { zh: '密码', en: 'Password' },
  'mask.kind.SECRET': { zh: '密钥', en: 'Secret' },
  'mask.kind.PRIVATE_KEY': { zh: '私钥', en: 'Private key' },
  'mask.kind.EMAIL': { zh: '邮箱', en: 'Email' },
  'mask.kind.PHONE': { zh: '手机号', en: 'Phone number' },
  'mask.kind.ID_CARD': { zh: '身份证号', en: 'ID number' },
  'mask.kind.BANK_CARD': { zh: '银行卡号', en: 'Card number' },
})

/** warn:「只提醒」档,原样发出了,不能说成遮住。 */
export interface MaskedValue { kind: string; ph: string; value: string; warn?: boolean }

/** 一组工具调用里会被遮住的值(按占位符去重,按出现顺序)。 */
export function collectMasked(events: ToolEvent[]): MaskedValue[] {
  const out = new Map<string, MaskedValue>()
  for (const ev of events) for (const m of ev.masked || []) {
    const src = m.at === 'args' ? ev.arguments : ev.result
    const value = src && m.e <= src.length ? src.slice(m.s, m.e) : ''
    if (value && !out.has(m.ph)) out.set(m.ph, { kind: m.kind, ph: m.ph, value, ...(m.warn ? { warn: true } : {}) })
  }
  return [...out.values()]
}

export const maskKindLabel = (t: (k: string) => string, kind: string): string => {
  const k = `mask.kind.${kind}`
  const s = t(k)
  return s === k ? kind : s
}
/** 对照表里本机那一列也不整串摊开:头 4 + 尾 4。 */
export const maskPreview = (v: string): string => (v.length > 12 ? `${v.slice(0, 4)}••••${v.slice(-4)}` : `${v.slice(0, Math.min(4, v.length))}••••`)

/** 文本里把会被遮住的值垫底色;悬停说模型收到的是什么。没有要垫的就原样返回字符串。 */
export function MaskedText({ text, masked }: { text: string; masked: MaskedValue[] }): React.ReactElement {
  const { t } = useI18n()
  const parts = useMemo(() => {
    if (!masked.length || !text) return null
    const byValue = new Map(masked.map((m) => [m.value, m]))
    const re = new RegExp([...byValue.keys()].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    const out: Array<string | MaskedValue> = []
    let last = 0
    for (const m of text.matchAll(re)) {
      out.push(text.slice(last, m.index), byValue.get(m[0])!)
      last = m.index! + m[0].length
    }
    return last ? [...out, text.slice(last)] : null
  }, [text, masked])
  if (!parts) return <>{text}</>
  return <>{parts.map((p, i) => typeof p === 'string' ? p : <span key={i} className="t2-masked" title={p.warn ? t('mask.gotRaw') : t('mask.got', { ph: p.ph })}>{p.value}</span>)}</>
}

/** 工具组标题后面那一句;点开是对照表。在 tool-group-head 这个 button 里面,所以自己是 span[role=button]、不冒泡。 */
export function MaskTag({ masked, sessionId }: { masked: MaskedValue[]; sessionId?: string }) {
  const { t } = useI18n()
  const ref = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState<{ x: number; y: number; top: number } | null>(null)
  const [picking, setPicking] = useState(false)
  const [allowed, setAllowed] = useState<Set<string>>(new Set())
  const toggle = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (at) { setAt(null); return }
    const r = ref.current!.getBoundingClientRect()
    setAt({ x: r.left - 6, y: r.bottom + 6, top: r.top })
  }
  const warned = masked.every((m) => m.warn)
  const allow = (m: MaskedValue) => void addMaskAllow(targetForSession(sessionId), m.value, m.kind).then(() => setAllowed((s) => new Set(s).add(m.ph))).catch(() => {})
  return (
    <>
      <span ref={ref} role="button" tabIndex={0} className={`t2-mask-tag${at ? ' open' : ''}`} onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } }}>
        <ShieldCheck size={13} />{masked.length === 1 ? t(warned ? 'mask.warnTag1' : 'mask.tag1') : t(warned ? 'mask.warnTag' : 'mask.tag', { n: masked.length })}
      </span>
      {at && createPortal(
        <div className="ui-popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { setAt(null); setPicking(false) } }}>
          <OverlayAt x={at.x} y={at.y} anchorTop={at.top} className="ui-popover t2-mask-pop">
            <h4>{t('mask.popTitle')}</h4>
            <table>
              <thead><tr><th>{t('mask.col.kind')}</th><th>{t('mask.col.local')}</th><th>{t('mask.col.sent')}</th>{picking && <th />}</tr></thead>
              <tbody>{masked.map((m) => (
                <tr key={m.ph}>
                  <td>{maskKindLabel(t, m.kind)}</td><td><code>{maskPreview(m.value)}</code></td><td>{m.warn ? t('mask.sentAsIs') : <code>{m.ph}</code>}</td>
                  {picking && <td>{allowed.has(m.ph) ? <span className="t2-mask-done">{t('mask.neverMasked')}</span>
                    : <button type="button" className="btn ghost sm" onClick={() => allow(m)}>{t('mask.neverMaskThis')}</button>}</td>}
                </tr>
              ))}</tbody>
            </table>
            <div className="t2-mask-foot">
              {!warned && <span>{t('mask.putBack')}</span>}
              <span className="grow" />
              {!picking && <button type="button" onClick={() => setPicking(true)}>{t('mask.neverMask')}</button>}
              <button type="button" onClick={() => { setAt(null); useApp.getState().openSettings('model/m-providers') }}>{t('mask.settings')}</button>
            </div>
          </OverlayAt>
        </div>, document.body)}
    </>
  )
}
