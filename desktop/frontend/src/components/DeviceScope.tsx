/**
 * 记忆按条标适用范围(11-06,方案页 Agent设备隔离方案_2026-11-04/round3.html「设备名写在内容里」):
 * 每条前面一个小标签(只在这台 / 只在某个系统 / 只在别的某台),记新的一条时选「所有设备 / 只在这台电脑(名字)/ 只在 macOS」。
 * 标签的认法和引擎同一份(tangu-agent contracts/deviceTags.ts);本机名、别台的名字由引擎随记忆快照给(snapshot.deviceTags)。
 */
import React from 'react'
import { registerMessages, useI18n } from '../i18n'
import './deviceScope.css'
import { lineTag, type AppliesTo, type DeviceTagContext } from '../../../../tangu-agent/src/contracts/deviceTags'

registerMessages({
  'deviceScope.all': { zh: '所有设备', en: 'All devices' },
  'deviceScope.thisComputer': { zh: '只在这台电脑（{name}）', en: 'Only this computer ({name})' },
  'deviceScope.thisOs': { zh: '只在 {os}', en: 'Only on {os}' },
  'deviceScope.label': { zh: '适用范围', en: 'Applies to' },
  'deviceScope.chipSelf': { zh: '只在这台电脑：{name}', en: 'Only on this computer: {name}' },
  'deviceScope.chipOs': { zh: '只在 {os} 上', en: 'Only on {os}' },
  'deviceScope.chipOther': { zh: '只在 {name} 上，这台电脑不用', en: 'Only on {name}; not used on this computer' },
})

export const NO_DEVICE_TAGS: DeviceTagContext = { self: null, os: null, others: [] }
const validCtx = (x: unknown): x is DeviceTagContext => !!x && typeof x === 'object' && Array.isArray((x as DeviceTagContext).others)
/** 快照里的设备上下文;老引擎 / 云端那份没有 → 只认系统名。 */
export const deviceTagsOf = (snapshot: { deviceTags?: unknown } | null | undefined): DeviceTagContext => validCtx(snapshot?.deviceTags) ? snapshot!.deviceTags as DeviceTagContext : NO_DEVICE_TAGS

/** 一条记忆:标签 + 正文(编辑框里只放正文,保存时引擎沿用原标签)。 */
export function splitScoped(content: string, ctx: DeviceTagContext): { label: string | null; kind: 'self' | 'os-here' | 'other' | null; body: string } {
  const t = lineTag(content, ctx)
  if (!t) return { label: null, kind: null, body: content }
  const kind = t.tag.kind === 'os' ? (ctx.os === t.tag.os ? 'os-here' : 'other') : t.tag.self ? 'self' : 'other'
  return { label: t.tag.label, kind, body: t.lead + t.body }
}

export const DeviceScopeChip: React.FC<{ label: string; kind: 'self' | 'os-here' | 'other' }> = ({ label, kind }) => {
  const { t } = useI18n()
  const title = kind === 'self' ? t('deviceScope.chipSelf', { name: label }) : kind === 'os-here' ? t('deviceScope.chipOs', { os: label }) : t('deviceScope.chipOther', { name: label })
  return <span className="device-scope-chip" data-scope={kind} title={title}>{label}</span>
}

/** 正文前带标签的一行(没有标签就是原文)。 */
export const ScopedText: React.FC<{ content: string; ctx: DeviceTagContext }> = ({ content, ctx }) => {
  const s = splitScoped(content, ctx)
  return <>{s.label && s.kind && <DeviceScopeChip label={s.label} kind={s.kind} />}{s.body}</>
}

/** 记新的一条时的适用范围菜单。不在一台电脑上(云端那份)时不画。 */
export const AppliesToSelect: React.FC<{ value: AppliesTo; onChange: (v: AppliesTo) => void; ctx: DeviceTagContext; disabled?: boolean }> = ({ value, onChange, ctx, disabled }) => {
  const { t } = useI18n()
  if (!ctx.self) return null
  return <select className="device-scope-select" aria-label={t('deviceScope.label')} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as AppliesTo)}>
    <option value="all">{t('deviceScope.all')}</option>
    <option value="this-computer">{t('deviceScope.thisComputer', { name: ctx.self })}</option>
    {ctx.os && <option value="this-os">{t('deviceScope.thisOs', { os: ctx.os })}</option>}
  </select>
}
