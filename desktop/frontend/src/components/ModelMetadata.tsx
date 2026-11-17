import type { ModelInfo } from '../types'
import { visibleModelTags } from '../services/accountQuota'
import './modelCatalog.css'

export function ModelMetadata({ model }: { model: Pick<ModelInfo, 'source' | 'tags' | 'multiplier'> }) {
  if (model.source !== 'forsion') return null
  // 服务端给旧版补的「限时 Trial」标签(kind: 'trial')不显示:新版在名字下面一行标限时开放
  const tags = visibleModelTags(model.tags)
  return <>
    {!!tags.length && <span className="model-tags">{tags.map((tag, index) => <span key={index} className="model-tag" data-color={tag.color} title={tag.text}>{tag.text}</span>)}</span>}
    {model.multiplier != null && Number.isFinite(model.multiplier) && model.multiplier >= 0 && <span className="model-multiplier">{model.multiplier.toFixed(2)}x</span>}
  </>
}
