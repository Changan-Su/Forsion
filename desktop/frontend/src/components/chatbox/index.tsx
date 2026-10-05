/** Host Chat Box API. Session orchestration lives in Composer2; prompt hosts use this component. */
import { useMemo, useState } from 'react'
import { ChatBox as ChatBoxBase, type ChatBoxProps as BaseProps } from '@lcl/components'
import { ModelPill } from '../ModelPill'
import { groupModelsByProvider } from '../ModelGroupList'
import { useModelPickerPreferences } from '../../modelPickerPreferences'
import { newChatModelId, useApp } from '../../stores/appStore'
import { useI18n } from '../../i18n'
import type { ChatBoxSelection } from '../../../../shared/chatBox'
export type { ChatBoxSelection, ChatBoxSubmission } from '../../../../shared/chatBox'

/** Local draft preferences: selecting here never changes another conversation or global defaults. */
export function useChatBoxSelection(agentSlug?: string) {
  const fallbackModel = useApp(newChatModelId)
  const agent = useApp(s => s.agentDefs.find(a => a.slug === agentSlug))
  const [override, setSelection] = useState<Partial<ChatBoxSelection>>({})
  const selection: ChatBoxSelection = {
    modelId: override.modelId ?? (agent?.model || fallbackModel || ''),
    thinkingLevel: override.thinkingLevel ?? (agent?.thinkingLevel || 'medium'),
  }
  return [selection, setSelection] as const
}

export interface ChatBoxProps extends BaseProps {
  selection: ChatBoxSelection
  onSelectionChange(selection: ChatBoxSelection): void
}

export function ChatBox({ selection, onSelectionChange, controls, ...props }: ChatBoxProps) {
  const { t } = useI18n()
  const catalog = useApp(s => s.modelsResp)
  const prefs = useModelPickerPreferences()
  const models = useMemo(() => (catalog?.models || []).filter(m => (m.modelType || 'llm') === 'llm'), [catalog])
  const groups = useMemo(() => groupModelsByProvider(models, prefs).map(g => ({
    key: g.key, label: g.provider, source: g.source,
    options: g.models.map(m => ({ ...m, description: `${m.provider} · ${m.id}` })),
  })), [models, prefs])
  return <ChatBoxBase {...props} controls={<>
    <ModelPill menuPortal groups={groups} modelId={selection.modelId} disabled={props.disabled}
      onSelectionChange={patch => onSelectionChange({ ...selection, ...patch })}
      onSelect={modelId => onSelectionChange({ ...selection, modelId })}
      thinkingLevel={selection.thinkingLevel}
      onThinkingChange={thinkingLevel => onSelectionChange({ ...selection, thinkingLevel })}
      supportedThinking={models.find(m => m.id === selection.modelId)?.thinkingLevels}
      emptyLabel={t('pill.noModels')} />
    {controls}
  </>} />
}
