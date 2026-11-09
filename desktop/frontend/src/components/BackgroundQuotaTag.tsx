/**
 * 「后台额度」小标签(11-09 方案 A):标在后台额度实际计入的那个模型上 —— 模型菜单里那一项、「跟随云端 · 它」、引导提示行开头。
 * 样式沿用管理员给模型贴的 .model-tag,颜色绿色读作「另送的」。只有知道计入的是哪个模型时才渲染(调用方判)。
 */
import { registerMessages, useI18n } from '../i18n'
import './modelCatalog.css'

registerMessages({
  'bgq.tag': { zh: '后台额度', en: 'Background quota' },
  'bgq.tagTip': {
    zh: '卜算子和自动化用这个模型时，扣 AI 额度之外另送的后台额度',
    en: 'When Muse and automations use this model, it draws on the background quota, an extra allowance on top of your AI quota',
  },
})

export function BackgroundQuotaTag(): React.ReactNode {
  const { t } = useI18n()
  return <span className="model-tag bgq-tag" title={t('bgq.tagTip')} data-bgq-tag="">{t('bgq.tag')}</span>
}
