import type { ModelInfo } from '../types'

/**
 * 主对话可选模型以当前后端返回的目录为能力真源。
 *
 * 不再拿 execMode=sandbox 推断「一定是云 worker」：本地 Chat 同样使用 sandbox，
 * 但 managed Tangu 后端仍持有并能执行本机直连 Provider。真正的云 worker 不会在
 * /agent/models 里返回 direct 模型，因此无需客户端再按会话执行模式裁剪。
 */
export function selectableChatModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => (m.modelType || 'llm') === 'llm')
}
