import { useEffect, useState } from 'react'
import { registerMessages, useI18n } from '../i18n'
import { getCompactionSettings, setCompactionSettings } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'

registerMessages({
  'autocompact.label': { zh: '自动压缩阈值', en: 'Auto-compact threshold' },
  'autocompact.hint': {
    zh: '上下文占到模型窗口的这个百分比时，自动把较早的对话总结成摘要、腾出空间（与输入框旁的上下文进度环同一口径）。默认 95% 相当于快满才压；1M 窗口的模型每一轮都要重读全部上下文，建议调到 20–35%（1M × 30% = 到 300k 时压缩）。对之后的新消息生效。',
    en: 'When the context reaches this share of the model’s window, earlier conversation is summarized to free up space (same scale as the context ring next to the input). The default 95% compacts only when nearly full; models with a 1M window re-read the whole context every turn, so 20–35% suits them better (1M × 30% = compacts at 300k). Applies to new messages.',
  },
  'autocompact.floor': {
    zh: '窗口较小的模型不会低于约 64k：再低就会每一轮都压。',
    en: 'For models with a smaller window the line never drops below about 64k — any lower and it would compact every turn.',
  },
  'autocompact.aria': { zh: '自动压缩阈值（占上下文窗口的百分比）', en: 'Auto-compact threshold (percent of the context window)' },
  'autocompact.reset': { zh: '恢复默认', en: 'Reset to default' },
})

/**
 * 设置 → 模型 → 分组与显示:全局「上下文到窗口的 X% 就自动压缩」。写引擎 config.json 的 compaction.thresholdPercent
 * (GET/PUT /agent/compaction);云端 worker 的 config.json 是所有用户共用的 → writable=false,整块不露。
 * 拖动只改本地显示,松手 / 键盘抬起 / 失焦才落盘(别每个像素打一次后端)。
 */
export function AutoCompactSetting({ cfg }: { cfg: TanguDesktopConfig }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ saved: number | null; def: number } | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    getCompactionSettings(cfg)
      .then((r) => { if (alive && r.writable) setState({ saved: r.settings.thresholdPercent ?? null, def: r.defaults.thresholdPercent }) })
      .catch(() => { /* 老引擎没有这个路由:整块不露 */ })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换引擎地址时重取;cfg 对象每次渲染可能是新引用
  }, [cfg.backendUrl])

  if (!state) return null
  const value = draft ?? state.saved ?? state.def
  const commit = async (next: number | null) => {
    setDraft(null)
    if (next === state.saved) return
    try {
      const r = await setCompactionSettings(cfg, { thresholdPercent: next })
      setState({ ...state, saved: r.settings.thresholdPercent ?? null })
      setError('')
    } catch (e: any) { setError(e?.message || String(e)) }
  }
  const release = () => { if (draft !== null) void commit(draft) }

  return <section className="field auto-compact-setting">
    <div className="theme-opt-row">
      <div className="theme-opt-label">
        <div>{t('autocompact.label')}</div>
      </div>
      <input
        type="range" min={10} max={95} step={5} value={value} aria-label={t('autocompact.aria')}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={release} onKeyUp={release} onBlur={release}
      />
      <output className="theme-opt-val">{value}%</output>
      <button className="btn ghost sm" disabled={state.saved === null} onClick={() => void commit(null)}>{t('autocompact.reset')}</button>
    </div>
    <div className="hint">{t('autocompact.hint')}</div>
    <div className="hint">{t('autocompact.floor')}</div>
    {error && <div className="hint model-catalog-error" role="alert">{error}</div>}
  </section>
}
