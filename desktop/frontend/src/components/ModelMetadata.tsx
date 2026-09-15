import type { ModelInfo } from '../types'
import './modelCatalog.css'

export function ModelMetadata({ model }: { model: Pick<ModelInfo, 'source' | 'tags' | 'multiplier'> }) {
  if (model.source !== 'forsion') return null
  return <>
    {!!model.tags?.length && <span className="model-tags">{model.tags.map((tag, index) => <span key={index} className="model-tag" data-color={tag.color} title={tag.text}>{tag.text}</span>)}</span>}
    {model.multiplier != null && Number.isFinite(model.multiplier) && model.multiplier >= 0 && <span className="model-multiplier">{model.multiplier.toFixed(2)}x</span>}
  </>
}
