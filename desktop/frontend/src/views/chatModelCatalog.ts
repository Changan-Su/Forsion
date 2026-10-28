import type { ModelInfo, ModelsResponse } from '../../../../tangu-agent/src/contracts/clientTypes'

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

/** 当前模型是不是直连模型(订阅 / 自带 key)。目录里有就看它的 source;目录外的(手填 `<provider>/<模型>`、旧会话存的裸 ID)
 *  照引擎注册表的规则认:前缀是某个直连 provider,或在它的 modelIds 里。 */
export function isDirectModelId(id: string, models: ModelInfo[] | null | undefined, r: ModelsResponse | null | undefined): boolean {
  const m = models?.find((x) => x.id === id)
  if (m) return m.source === 'direct'
  return !!r?.directProviders?.some((p) => id.startsWith(`${p.providerId}/`) || p.modelIds?.includes(id))
}
