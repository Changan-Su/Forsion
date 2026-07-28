/**
 * 「辅助模型」选择器 —— 区别于主模型的那一档,两个槽合用一套 UI:
 *   · 辅助 LLM   —— 后台/特殊 agent(Muse、Historian)跑的活,挑个便宜的就行
 *   · 图像识别   —— 主模型没有原生多模态时的看图兜底,以及非聊天场景的快速识图
 *
 * 自包含(getConfig/setConfig 直写 ~/.tangu/config.json 的 models 段,引擎侧
 * specialAgentsConfig / visionService 读同一段),设置页与引导页复用 —— 同 AsrModelChoice。
 * 不选 = 跟随 admin 的 app 级槽(hint 里显示跟随到了谁)。非桌面环境自动隐藏。
 */
import { useEffect, useState } from 'react'
import { Check, Eye, Sparkles } from 'lucide-react'
import { useI18n } from '../i18n'
import type { ModelInfo, ModelsResponse } from '../types'

type Slot = 'background' | 'vision'

export function AuxModelChoice({ models }: { models: ModelsResponse | null }) {
  const { t } = useI18n()
  const [background, setBackground] = useState('')
  const [vision, setVision] = useState('')

  useEffect(() => {
    void window.tangu?.getConfig?.().then((c) => {
      setBackground(c.backgroundModelId || '')
      setVision(c.visionModelId || '')
    })
  }, [])

  if (!window.tangu?.getConfig) return null // 非桌面环境(云端 Web/移动端)不显示

  const llms = (models?.models || []).filter((m) => (m.modelType || 'llm') === 'llm')
  // 图像识别槽只列**能看图**的模型:选了个没视觉的进去,主模型无视觉时会先被辅助模型拒图、
  // 再把原图退给同样看不了的主模型,整轮必挂——这种选项不该出现在列表里(Codex 评审)。
  const visionCapable = llms.filter((m) => m.supportsVision !== false)
  const pick = (slot: Slot, id: string): void => {
    if (slot === 'background') { setBackground(id); void window.tangu?.setConfig?.({ backgroundModelId: id }) }
    else { setVision(id); void window.tangu?.setConfig?.({ visionModelId: id }) }
  }

  const row = (slot: Slot, selectedId: string, cloudDefault: string) => (
    <div className="model-group-body">
      {(slot === 'vision' ? visionCapable : llms).map((m) => {
        const sel = selectedId === m.id
        return (
          <button
            key={`${slot}-${m.source}-${m.id}`}
            className={`file-row${sel ? ' active' : ''}`}
            onClick={() => pick(slot, sel ? '' : m.id)} // 再点一次取消选中 → 回到跟随云端默认
          >
            {slot === 'vision' ? <Eye size={13} /> : <Sparkles size={13} />}
            <span className="file-name" style={{ color: sel ? 'var(--accent-ink)' : undefined }}>{m.name}</span>
            {m.source === 'direct' && <span className="model-group-tag">{t('model.group.direct')}</span>}
            {!selectedId && m.id === cloudDefault && <span className="model-group-tag">{t('settings.model.imageCloudDefaultTag')}</span>}
            {sel && <Check size={12} style={{ color: 'var(--accent-ink)' }} />}
          </button>
        )
      })}
    </div>
  )

  const nameOf = (id: string | null | undefined): string =>
    (id && (models?.models || []).find((m: ModelInfo) => m.id === id)?.name) || id || ''

  return (
    <>
      <div className="field">
        <label>{t('settings.aux.llmLabel')}</label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.aux.llmHint')}</div>
        {llms.length ? row('background', background, models?.backgroundModelId || '') : <div className="hint">{t('model.empty')}</div>}
        {!background && models?.backgroundModelId && (
          <div className="hint" style={{ marginTop: 4 }}>{t('settings.aux.following', { model: nameOf(models.backgroundModelId) })}</div>
        )}
      </div>

      <div className="field">
        <label>{t('settings.aux.visionLabel')}</label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.aux.visionHint')}</div>
        {visionCapable.length ? row('vision', vision, models?.visionModelId || '') : <div className="hint">{t('model.empty')}</div>}
        {!vision && models?.visionModelId && (
          <div className="hint" style={{ marginTop: 4 }}>{t('settings.aux.following', { model: nameOf(models.visionModelId) })}</div>
        )}
      </div>
    </>
  )
}
