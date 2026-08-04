/**
 * 「辅助模型」选择器 —— 区别于主模型的那一档,两个槽合用一套 UI:
 *   · 辅助 LLM   —— 后台/特殊 agent(Muse、Historian)跑的活,挑个便宜的就行
 *   · 图像识别   —— 主模型没有原生多模态时的看图兜底,以及非聊天场景的快速识图
 *
 * 自包含(getConfig/setConfig 直写 ~/.tangu/config.json 的 models 段,引擎侧
 * specialAgentsConfig / visionService 读同一段),设置页与引导页复用 —— 同 AsrModelChoice。
 * 不选 = 跟随 admin 的 app 级槽(选择器里显示跟随到了谁)。非桌面环境自动隐藏。
 */
import { useEffect, useState } from 'react'
import { Eye, Sparkles } from 'lucide-react'
import { ModelSelect } from './ModelSelect'
import { registerMessages, useI18n } from '../i18n'
import type { ModelsResponse, VisionMode } from '../types'

registerMessages({
  'aux.visionModeLabel': { zh: '何时使用图像识别', en: 'When to use image recognition' },
  'aux.visionMode.auto': { zh: '自动 — 主模型看不了图时才用', en: 'Auto — only when the main model has no vision' },
  'aux.visionMode.always': { zh: '总是 — 所有图都先转成文字', en: 'Always — transcribe every image first' },
  'aux.visionMode.off': { zh: '关闭 — 图直接发给主模型', en: 'Off — send images straight to the main model' },
  'aux.visionModeAutoWarn': {
    zh: '「自动」靠一份内置名单判断主模型有没有视觉,名单外的纯文本模型会被当成能看图。图发过去没反应就改选「总是」。',
    en: 'Auto relies on a built-in list to tell whether the main model has vision; text-only models outside that list are assumed to have it. If images get ignored, switch to Always.',
  },
})

export function AuxModelChoice({ models }: { models: ModelsResponse | null }) {
  const { t } = useI18n()
  const [background, setBackground] = useState('')
  const [vision, setVision] = useState('')
  const [visionMode, setVisionMode] = useState<VisionMode>('auto')

  useEffect(() => {
    void window.tangu?.getConfig?.().then((c) => {
      setBackground(c.backgroundModelId || '')
      setVision(c.visionModelId || '')
      setVisionMode(c.visionMode || 'auto')
    })
  }, [])

  if (!window.tangu?.getConfig) return null // 非桌面环境(云端 Web/移动端)不显示

  const llms = (models?.models || []).filter((m) => (m.modelType || 'llm') === 'llm')
  // 图像识别槽只列**能看图**的模型:选了个没视觉的进去,主模型无视觉时会先被辅助模型拒图、
  // 再把原图退给同样看不了的主模型,整轮必挂——这种选项不该出现在列表里(Codex 评审)。
  const visionCapable = llms.filter((m) => m.supportsVision !== false)

  const modes: VisionMode[] = ['auto', 'always', 'off']

  return (
    <>
      <div className="field">
        <label>{t('settings.aux.llmLabel')}</label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.aux.llmHint')}</div>
        <ModelSelect
          models={llms}
          value={background}
          cloudDefaultId={models?.backgroundModelId}
          icon={<Sparkles size={13} />}
          onChange={(id) => { setBackground(id); void window.tangu?.setConfig?.({ backgroundModelId: id }) }}
        />
      </div>

      <div className="field">
        <label>{t('settings.aux.visionLabel')}</label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.aux.visionHint')}</div>
        <ModelSelect
          models={visionCapable}
          value={vision}
          cloudDefaultId={models?.visionModelId}
          icon={<Eye size={13} />}
          disabled={visionMode === 'off'}
          onChange={(id) => { setVision(id); void window.tangu?.setConfig?.({ visionModelId: id }) }}
        />
        <label style={{ marginTop: 10 }}>{t('aux.visionModeLabel')}</label>
        <div className="model-group-body" style={{ paddingLeft: 0 }}>
          {modes.map((m) => (
            <button
              key={m}
              className={`file-row${visionMode === m ? ' active' : ''}`}
              onClick={() => { setVisionMode(m); void window.tangu?.setConfig?.({ visionMode: m }) }}
            >
              <span className="file-name" style={{ color: visionMode === m ? 'var(--accent-ink)' : undefined }}>
                {t(`aux.visionMode.${m}`)}
              </span>
            </button>
          ))}
        </div>
        {visionMode === 'auto' && <div className="hint" style={{ marginTop: 6 }}>{t('aux.visionModeAutoWarn')}</div>}
      </div>
    </>
  )
}
