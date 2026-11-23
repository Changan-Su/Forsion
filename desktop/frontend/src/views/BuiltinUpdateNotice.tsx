/**
 * 内置 Agent(Coding / Muse)的指令有新版本、而用户改过(引擎 agents/builtinBaseline.ts):配置页「指令」一节上方的提示。
 * 升级没动用户的文本;这里给看新旧默认差了什么,由用户选「保留我的」或「用新默认」。不发通知,只在这一页。
 * 差异沿用改动记录的 FileDiff(逐行 + 成对行只标改掉的字词)。「用新默认」会换掉用户的字,所以先二次确认。
 */
import { useMemo, useState } from 'react'
import { createTwoFilesPatch } from 'diff'
import { useI18n } from '../i18n'
import { FileDiff } from './chat2/FileDiff'
import type { BuiltinUpdate } from '../types'
import './agentProfileMessages'

/** 两段文本 → FileDiff 吃的统一 diff 正文(去掉文件头,上下文 1 行)。导出给单测。 */
export function builtinUpdatePatch(from: string, to: string): string {
  const patch = createTwoFilesPatch('a', 'b', from.endsWith('\n') ? from : `${from}\n`, to.endsWith('\n') ? to : `${to}\n`, '', '', { context: 1 })
  const at = patch.indexOf('\n@@')
  return at < 0 ? '' : patch.slice(at + 1)
}

export function BuiltinUpdateNotice({ update, busy, adoptBlocked, onKeep, onAdopt }: {
  update: BuiltinUpdate
  busy: boolean
  /** 这一页还有没保存的指令 / 人格修改:换新会和它撞上(保存时报冲突),先让用户处理掉。 */
  adoptBlocked: boolean
  onKeep: () => void
  onAdopt: () => void
}) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  // 每一项都知道「当初基于哪份默认」才比新旧默认;有一项不知道(没有基线的老用户)就整张卡改比「你的版本 vs 新默认」
  const known = update.fields.every((f) => f.oldDefault !== null)
  const from = known && update.fields.every((f) => f.fromVersion === update.fields[0].fromVersion) ? update.fields[0].fromVersion : undefined
  const title = !known ? t('agentProfile.builtinUpdate.titleUnknown')
    : from && update.toVersion && from !== update.toVersion ? t('agentProfile.builtinUpdate.titleVersion', { from, to: update.toVersion })
    : t('agentProfile.builtinUpdate.title')
  const patches = useMemo(() => update.fields.map((f) => ({ field: f.field, patch: builtinUpdatePatch(known ? f.oldDefault! : f.current, f.newDefault) })), [update, known])
  return <section className="builtin-update" data-builtin-update={update.slug} aria-label={title}>
    <div className="builtin-update-head">
      <strong>{title}</strong>
      <span className="builtin-update-actions">
        {confirming ? <>
          <button type="button" className="btn ghost sm" data-act="builtin-back" disabled={busy} onClick={() => setConfirming(false)}>{t('agentProfile.builtinUpdate.back')}</button>
          <button type="button" className="btn danger sm" data-act="builtin-adopt-confirm" disabled={busy || adoptBlocked} onClick={onAdopt}>{t('agentProfile.builtinUpdate.adoptConfirm')}</button>
        </> : <>
          <button type="button" className="btn ghost sm" data-act="builtin-keep" disabled={busy} onClick={onKeep}>{t('agentProfile.builtinUpdate.keep')}</button>
          <button type="button" className="btn ghost sm" data-act="builtin-adopt" disabled={busy || adoptBlocked} title={adoptBlocked ? t('agentProfile.builtinUpdate.adoptBlocked') : undefined} onClick={() => setConfirming(true)}>{t('agentProfile.builtinUpdate.adopt')}</button>
        </>}
      </span>
    </div>
    <p className="agent-profile-muted">{confirming ? t('agentProfile.builtinUpdate.adoptWarn') : adoptBlocked ? t('agentProfile.builtinUpdate.adoptBlocked') : t(known ? 'agentProfile.builtinUpdate.body' : 'agentProfile.builtinUpdate.bodyUnknown')}</p>
    {patches.map(({ field, patch }) => <div key={field} className="builtin-update-field" data-field={field}>
      <small><span>{t(field === 'soul' ? 'agentProfile.soul' : 'agentProfile.prompt')}</span><span>{t(known ? 'agentProfile.builtinUpdate.legendDefaults' : 'agentProfile.builtinUpdate.legendYours')}</span></small>
      <FileDiff patch={patch} prose />
    </div>)}
  </section>
}
