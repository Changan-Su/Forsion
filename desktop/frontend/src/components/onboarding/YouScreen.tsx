/**
 * ③ 关于你:写几句自己,存进 human/MEMORY.md(「关于我」,所有 Agent 都读;Agents › 我 › 记忆 里同一份)。
 * 进这一屏读一次现有内容当底稿;离开往前时只在改过才写(带 expectedVersion,别处改过 = 409 → 重新读、停在这一屏让用户再看)。
 * 读失败 ≠ 空:读不到就不写,免得拿空白盖掉原来的资料(仓规「读写用户数据」)。
 * human/ 只接受本机写(远端 403),所以这一屏只在桌面完整引导里有。从其他 AI 导入(#441)合进来之后再加那一行。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Lock, Plus } from 'lucide-react'
import { useI18n } from '../../i18n'
import { getHumanDocument, saveHumanDocument, type HumanDocument } from '../../services/humanCollaboration'
import type { EngineTarget } from '../../services/engine/targets'

const TARGET = { kind: 'human', file: 'MEMORY.md' } as const

export function YouScreen({ resolveTarget, commitRef }: {
  resolveTarget: () => Promise<EngineTarget>
  commitRef: React.MutableRefObject<(() => Promise<void>) | null>
}): React.ReactNode {
  const { t } = useI18n()
  const [doc, setDoc] = useState<HumanDocument | null>(null)
  const [text, setText] = useState('')
  const [loadError, setLoadError] = useState('')
  const [note, setNote] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const state = useRef({ doc, text })
  state.current = { doc, text }

  const load = async (): Promise<HumanDocument | null> => {
    try {
      const d = await getHumanDocument(await resolveTarget(), TARGET)
      setDoc(d); setText(d.content); setLoadError('')
      return d
    } catch (e) { setLoadError(String((e as Error)?.message || e)); return null }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    commitRef.current = async () => {
      const { doc: d, text: next } = state.current
      if (!d || next === d.content) return
      try {
        const r = await saveHumanDocument(await resolveTarget(), TARGET, next, d.version, 'Onboarding: About me')
        setDoc(r.document)
      } catch (e) {
        if ((e as { status?: number }).status === 409) { await load(); setNote(t('ob3.you.conflict')) }
        throw e
      }
    }
    return () => { commitRef.current = null }
  }, [commitRef, resolveTarget, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const max = doc?.maxLength || 2000
  const add = (line: string): void => {
    const next = text && !text.endsWith('\n') ? `${text}\n${line}` : `${text}${line}`
    setText(next.slice(0, max))
    requestAnimationFrame(() => { const a = areaRef.current; if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length) } })
  }
  return <div className="ob3-col narrow">
    <div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('ob3.you.title')}</h1><p>{t('ob3.you.desc')}</p></div>
    <section className="ob3-card ob3-you" data-ob-you="">
      <textarea ref={areaRef} value={text} maxLength={max} disabled={!doc} placeholder={t('ob3.you.placeholder')} aria-label={t('ob3.you.title')}
        onChange={(e) => { setText(e.target.value); setNote('') }} />
      <div className="ob3-you-bar">
        {([['ob3.you.chip.name', 'ob3.you.chip.nameLine'], ['ob3.you.chip.work', 'ob3.you.chip.workLine'], ['ob3.you.chip.style', 'ob3.you.chip.styleLine']] as const).map(([label, line]) => (
          <button key={label} type="button" className="ob3-pill" disabled={!doc} onClick={() => add(t(line))}><Plus size={12} aria-hidden="true" />{t(label)}</button>
        ))}
        <span className="ob3-count">{text.length} / {max}</span>
      </div>
    </section>
    {loadError && <div className="ob3-error" role="alert">{t('ob3.you.loadFailed', { error: loadError })}</div>}
    {note && <div className="ob3-feedback" role="status">{note}</div>}
    <div className="ob3-where"><Lock size={12} aria-hidden="true" />{t('ob3.you.where')}</div>
  </div>
}
