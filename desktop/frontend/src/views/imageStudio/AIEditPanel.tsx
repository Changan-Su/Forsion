import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useWorkspace } from '@lcl/engine'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useImageStudio } from '../../stores/imageStudioStore'
import type { ImageBoard, StudioImage } from './model'
import { ensureImageSession } from './session'
import { EDIT_QUALITIES, EDIT_RATIOS, editAttachments, editPrompt, type EditMode } from './aiEditing'
import { outputRatioPlan, type ImageSourceMode } from './generation'

export function AIEditPanel({ board, images }: { board: ImageBoard; images: StudioImage[] }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<EditMode>('edit'), [instruction, setInstruction] = useState('')
  const [ratio, setRatio] = useState('original'), [source, setSource] = useState<ImageSourceMode>('current')
  const [count, setCount] = useState(1), [margin, setMargin] = useState(.5), [quality, setQuality] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useApp(s => !!(board.sessionId && s.runningBySession[board.sessionId]))
  const ratioPlan = outputRatioPlan(images[0], ratio)
  const submit = async () => {
    setBusy(true); setError('')
    let placeholderIds: string[] = []
    try {
      const sessionId = await ensureImageSession(board.id)
      if (useImageStudio.getState().activeId !== board.id) return
      if (useApp.getState().runningBySession[sessionId]) throw new Error(t('imageStudio.ai.wait'))
      placeholderIds = useImageStudio.getState().beginGeneration(board.id, sessionId, {
        count, aspect: ratioPlan.aspect, ratio: ratioPlan.requested, kind: 'edit', sourceIds: images.map(image => image.id),
      })
      const sourceMode = mode === 'expand' ? 'current' : source
      const attachments = await editAttachments(images, mode, ratioPlan.requested, margin, sourceMode)
      useWorkspace.getState().openView('image-studio-chat', {}, 'left')
      const sent = await useApp.getState().send(editPrompt(mode, instruction, ratioPlan, count, sourceMode, quality), attachments, undefined, undefined, undefined, sessionId)
      if (!sent) throw new Error(t('imageStudio.ai.sendFailed'))
      useImageStudio.getState().activateGeneration(placeholderIds)
    } catch (e) {
      if (placeholderIds.length) useImageStudio.getState().failGeneration(board.id, { ids: placeholderIds })
      setError(e instanceof Error ? e.message : String(e))
    }
    finally { setBusy(false) }
  }
  return <details className="ims-ai" open><summary><Sparkles size={15} />{t('imageStudio.ai.title')}<span>{images.length} {t('imageStudio.ai.references')}</span></summary>
    <div className="ims-ai-body"><div className="ims-ai-modes" role="group" aria-label={t('imageStudio.ai.mode')}>
      {(['edit', 'background', 'expand'] as const).map(value => <button key={value} aria-pressed={mode === value} disabled={running || busy || (value !== 'edit' && images.length !== 1)} onClick={() => setMode(value)}>{t(`imageStudio.ai.${value}`)}</button>)}
    </div>
    <p className="ims-caption">{t(`imageStudio.ai.hint.${mode}`)}</p>
    <textarea aria-label={t('imageStudio.ai.instruction')} placeholder={t('imageStudio.ai.placeholder')} value={instruction} onChange={e => setInstruction(e.target.value)} maxLength={8000} rows={3} disabled={busy || running} />
    <label className="ims-ai-source">{t('imageStudio.ai.source')}<select aria-label={t('imageStudio.ai.source')} value={mode === 'expand' ? 'current' : source} onChange={e => setSource(e.target.value as ImageSourceMode)} disabled={busy || running || mode === 'expand'}>
      <option value="current">{t('imageStudio.ai.source.current')}</option><option value="original">{t('imageStudio.ai.source.original')}</option>
    </select></label>
    <div className="ims-fields"><label>{t('imageStudio.ai.ratio')}<select aria-label={t('imageStudio.ai.ratio')} value={ratio} onChange={e => setRatio(e.target.value)} disabled={busy || running}>
      <option value="original">{t('imageStudio.ai.ratio.original', { ratio: ratioPlan.originalLabel })}</option>{EDIT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
    </select></label>
      <label>{t('imageStudio.ai.count')}<select aria-label={t('imageStudio.ai.count')} value={count} onChange={e => setCount(Number(e.target.value))} disabled={busy || running}>{[1, 2, 3, 4].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>{t('imageStudio.ai.quality')}<select aria-label={t('imageStudio.ai.quality')} value={quality} onChange={e => setQuality(e.target.value)} disabled={busy || running}>
        <option value="">{t('imageStudio.ai.quality.default')}</option>{EDIT_QUALITIES.map(q => <option key={q} value={q}>{t(`imageStudio.ai.quality.${q}`)}</option>)}
      </select></label></div>
    {ratioPlan.requested !== ratioPlan.engine && <p className="ims-caption ims-ai-ratio-note">{t('imageStudio.ai.ratioFit', { ratio: ratioPlan.requested, engineRatio: ratioPlan.engine })}</p>}
    {(quality === 'xhigh' || quality === 'max') && <p className="ims-caption">{t('imageStudio.ai.qualityNote')}</p>}
    {mode === 'expand' && <label>{t('imageStudio.ai.margin')}<input aria-label={t('imageStudio.ai.margin')} type="range" min=".1" max="1" step=".1" value={margin} onChange={e => setMargin(Number(e.target.value))} /><output>{Math.round(margin * 100)}%</output></label>}
    <button className="ims-primary" disabled={busy || running || !images.length || images.length > 8 || (mode === 'edit' && !instruction.trim())} onClick={() => void submit()}><Sparkles size={15} />{t(running || busy ? 'imageStudio.ai.running' : 'imageStudio.ai.submit')}</button>
    <p className="ims-caption">{t('imageStudio.ai.preserve')}</p>{error && <p role="alert">{error}</p>}
    </div>
  </details>
}
