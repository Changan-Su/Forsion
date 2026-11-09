/**
 * ③ 关于你(11-08 方案 A「三问卡」):怎么称呼 / 在做什么 / 怎么回答 / 用什么语言回,底下「还想让 Agent 知道的」折叠着。
 * 存进 human/MEMORY.md 最前面的一节 `## 关于我` / `## About me`(所有 Agent 都读;Agents › 我 › 记忆 里同一份),
 * 读写规则在 aboutMe.ts:引擎播种的空模板当空;那一节按答案里的字定语言;认不得的行进自由框,存回时一字不动。
 * 进这一屏读一次;离开往前时只在改过才写(带 expectedVersion,别处改过 = 409 → 重新读、停在这一屏让用户再看)。
 * 读失败 ≠ 空:读不到就不写,免得拿空白盖掉原来的资料(仓规「读写用户数据」)。
 * human/ 只接受本机写(远端 403),所以这一屏只在桌面完整引导里有。「从其他 AI 搬过来」复用 ExternalImportEntry(写画像 SOUL.md)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ChevronRight, Lock, PenLine } from 'lucide-react'
import { useI18n } from '../../i18n'
import { getHumanDocument, saveHumanDocument, type HumanDocument } from '../../services/humanCollaboration'
import type { EngineTarget } from '../../services/engine/targets'
import { ExternalImportEntry } from '../ExternalImport'
import { noteOnboarding } from './onboardingTelemetry'
import { EMPTY_ABOUT_ME, NAME_MAX, STYLES, WORKS, WORK_TEXT_MAX, parseAboutMe, sectionLangOf, serializeAboutMe, serializeSection,
  type AboutMe, type AnswerLang, type ParsedAboutMe } from './aboutMe'

const TARGET = { kind: 'human', file: 'MEMORY.md' } as const
/** 语言名用它自己的文字写(和语言切换器一样),不进翻译字典。 */
const LANG_NAMES = { zh: '中文', en: 'English' } as const

export function YouScreen({ resolveTarget, commitRef }: {
  resolveTarget: () => Promise<EngineTarget>
  commitRef: React.MutableRefObject<(() => Promise<void>) | null>
}): React.ReactNode {
  const { t, locale } = useI18n()
  const [engine, setEngine] = useState<EngineTarget | null>(null)
  const [doc, setDoc] = useState<HumanDocument | null>(null)
  const [loaded, setLoaded] = useState<ParsedAboutMe | null>(null)
  const [form, setForm] = useState<AboutMe>(EMPTY_ABOUT_ME)
  const [moreOpen, setMoreOpen] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [note, setNote] = useState('')
  const moreRef = useRef<HTMLTextAreaElement>(null)
  const state = useRef({ doc, loaded, form, locale })
  state.current = { doc, loaded, form, locale }

  const load = async (): Promise<HumanDocument | null> => {
    try {
      const target = await resolveTarget()
      setEngine(target)
      const d = await getHumanDocument(target, TARGET)
      const p = parseAboutMe(d.content)
      setDoc(d); setLoaded(p); setForm(p.form); setLoadError('')
      if (p.form.more) setMoreOpen(true) // 认不得的原样放在自由框里,展开给人看见
      return d
    } catch (e) { setLoadError(String((e as Error)?.message || e)); return null }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 那一节用哪种语言写:答案里的字 → 原来那一节 → 界面语言。 */
  const langFor = (f: AboutMe, p: ParsedAboutMe | null, ui: typeof locale) => sectionLangOf(f, p?.sectionLang ?? ui)

  useEffect(() => {
    commitRef.current = async () => {
      const { doc: d, loaded: p, form: f, locale: ui } = state.current
      if (!d || !p) return
      const next = serializeAboutMe(f, langFor(f, p, ui))
      // 和读进来时的序列化比,不和原文比:原文的空行 / 换行风格不该让老资料每次进来都被重写一遍
      if (next === serializeAboutMe(p.form, langFor(p.form, p, ui))) { noteOnboarding({ youWritten: false }); return }
      if (next.length > d.maxLength) throw new Error(t('ob3.you.tooLong', { max: d.maxLength }))
      try {
        const r = await saveHumanDocument(await resolveTarget(), TARGET, next, d.version, 'Onboarding: About me')
        const again = parseAboutMe(r.document.content)
        setDoc(r.document); setLoaded(again)
        noteOnboarding({ youWritten: true }) // 匿名遥测只记写没写,内容不碰
      } catch (e) {
        if ((e as { status?: number }).status === 409) { await load(); setNote(t('ob3.you.conflict')) }
        throw e
      }
    }
    return () => { commitRef.current = null }
  }, [commitRef, resolveTarget, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<AboutMe>): void => { setForm((f) => ({ ...f, ...patch })); setNote('') }
  const off = !doc
  const max = doc?.maxLength || 2000
  const lang = langFor(form, loaded, locale)
  const section = serializeSection(form, lang)
  const total = serializeAboutMe(form, lang).length
  const moreMax = Math.max(0, max - (section ? section.length + 3 : 1)) // 那一节 + 空一行 + 末尾换行;上限是整份文件的

  const pill = (key: string, on: boolean, pick: () => void, label: string, attrs: Record<string, string> = {}): React.ReactNode =>
    <button key={key} type="button" className="ob3-pill" aria-pressed={on} disabled={off} onClick={pick} {...attrs}>{label}</button>
  const question = (label: string, body: React.ReactNode, group = true): React.ReactNode =>
    <div className="ob3-q"><span>{label}</span>{group ? <div className="ob3-actions" role="group" aria-label={label}>{body}</div> : body}</div>
  const openMore = (): void => {
    const next = !moreOpen
    setMoreOpen(next)
    if (next) requestAnimationFrame(() => moreRef.current?.focus())
  }

  return <div className="ob3-col narrow">
    <div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('ob3.you.title')}</h1><p>{t('ob3.you.desc')}</p></div>
    <section className="ob3-card ob3-about" data-ob-you="">
      {question(t('ob3.you.q.name'),
        <input className="ob3-text" value={form.name} maxLength={NAME_MAX} disabled={off} placeholder={t('ob3.you.namePh')} aria-label={t('ob3.you.q.name')}
          data-ob-you-name="" onChange={(e) => set({ name: e.target.value })} />, false)}
      {question(t('ob3.you.q.work'), <>
        {WORKS.map((w) => pill(w, form.works.includes(w), () => set({ works: form.works.includes(w) ? form.works.filter((x) => x !== w) : [...form.works, w] }),
          t(`ob3.you.work.${w}`), { 'data-ob-you-work': w }))}
        <label className="ob3-own"><PenLine size={12} aria-hidden="true" /><input value={form.workText} maxLength={WORK_TEXT_MAX} disabled={off} placeholder={t('ob3.you.workOwn')}
          aria-label={t('ob3.you.workOwn')} data-ob-you-work-own="" onChange={(e) => set({ workText: e.target.value })} /></label>
      </>)}
      {question(t('ob3.you.q.style'), STYLES.map((s) => pill(s, form.style === s, () => set({ style: form.style === s ? '' : s }), t(`ob3.you.style.${s}`), { 'data-ob-you-style': s })))}
      {question(t('ob3.you.q.lang'), (['auto', 'zh', 'en'] as const).map((l: AnswerLang) =>
        pill(l, form.lang === l, () => set({ lang: l === 'auto' || form.lang === l ? 'auto' : l }), l === 'auto' ? t('ob3.you.lang.auto') : LANG_NAMES[l],
          l === 'auto' ? { 'data-ob-you-lang': l } : { 'data-ob-you-lang': l, lang: l === 'zh' ? 'zh-CN' : 'en' })))}
      <div className="ob3-sep" />
      <button type="button" className="ob3-adv" aria-expanded={moreOpen} disabled={off} data-ob-you-more="" onClick={openMore}>
        <ChevronRight size={13} aria-hidden="true" data-motion="chevron" data-open={moreOpen} />{t('ob3.you.more')}</button>
      {moreOpen && <div className="ob3-more" data-motion="enter">
        <textarea ref={moreRef} value={form.more} maxLength={Math.max(moreMax, form.more.length)} disabled={off} placeholder={t('ob3.you.placeholder')} aria-label={t('ob3.you.more')}
          onChange={(e) => set({ more: e.target.value })} />
        <span className={`ob3-count${total > max ? ' over' : ''}`}>{total} / {max}</span>
      </div>}
    </section>
    <section className="ob3-card ob3-imp">{engine && <ExternalImportEntry engine={engine} layout="row" />}</section>
    {loadError && <div className="ob3-error" role="alert">{t('ob3.you.loadFailed', { error: loadError })}</div>}
    {note && <div className="ob3-feedback" role="status">{note}</div>}
    <div className="ob3-where"><Lock size={12} aria-hidden="true" />{t('ob3.you.where')}</div>
  </div>
}
