/** DOM plugin adapter for the same Chat Box used by first-party prompt Views. */
import { useEffect, useRef, useState } from 'react'
import { ChatBox, useChatBoxSelection, type ChatBoxSubmission } from '../../components/chatbox'
import { HostLocaleProvider, registerMessages, useI18n } from '../../i18n'
import { mountHostReact } from '@lcl/components'
import type { PluginChatBoxHandle, PluginChatBoxOptions } from '../../../../shared/chatBox'

registerMessages({
  'chatbox.label': { zh: '输入内容', en: 'Message' },
  'chatbox.submitFailed': { zh: '提交失败，内容已保留，请重试。', en: 'Submission failed. Your draft is preserved; try again.' },
})

function PluginChatBox({ options, revision, input, isAlive }: { options: PluginChatBoxOptions; revision: number; input: { current: HTMLTextAreaElement | null }; isAlive(): boolean }) {
  const { t } = useI18n()
  const [text, setText] = useState(options.value || '')
  const [selection, setSelection] = useChatBoxSelection(options.agentSlug)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const sending = useRef(false)
  const effective = {
    modelId: options.modelId ?? selection.modelId,
    thinkingLevel: options.thinkingLevel ?? selection.thinkingLevel,
  }
  useEffect(() => { if (options.value !== undefined) setText(options.value) }, [options.value, revision])
  const change = (draft: ChatBoxSubmission) => {
    setText(draft.text); setSelection(draft); setError(false)
    // The mount retains the draft across update() calls that only change presentation.
    options.value = draft.text; options.modelId = draft.modelId; options.thinkingLevel = draft.thinkingLevel
    options.onChange?.(draft)
  }
  return <ChatBox value={text} onValueChange={value => change({ ...effective, text: value })}
    selection={effective} onSelectionChange={value => change({ ...value, text })} inputRef={input}
    inputProps={{ 'aria-label': options.label || t('chatbox.label'), placeholder: options.placeholder }}
    disabled={options.disabled || busy} submitDisabled={!text.trim()} submitOn={options.submitOn}
    submitLabel={options.submitLabel || t('input.send')}
    afterInput={error ? <p role="alert">{t('chatbox.submitFailed')}</p> : undefined}
    onSubmit={() => {
      if (sending.current || !text.trim() || !isAlive()) return
      sending.current = true; setBusy(true); setError(false)
      const submitted = { ...effective, text }
      void Promise.resolve().then(() => options.onSubmit(submitted)).then(accepted => {
        if (isAlive() && accepted && options.value === submitted.text) change({
          modelId: options.modelId ?? effective.modelId,
          thinkingLevel: options.thinkingLevel ?? effective.thinkingLevel,
          text: '',
        })
      }).catch(() => { if (isAlive()) setError(true) }).finally(() => {
        sending.current = false
        if (isAlive()) setBusy(false)
      })
    }} />
}

export function mountPluginChatBox(el: HTMLElement, initial: PluginChatBoxOptions): PluginChatBoxHandle {
  const options = { ...initial }
  const input = { current: null as HTMLTextAreaElement | null }
  let alive = true, revision = 0
  let unmount = () => {}
  const render = () => {
    unmount = mountHostReact(el, <HostLocaleProvider><PluginChatBox options={options} revision={revision++} input={input} isAlive={() => alive} /></HostLocaleProvider>)
  }
  render()
  return {
    update(patch) { if (alive) { Object.assign(options, patch); render() } },
    focus() { if (alive) input.current?.focus() },
    dispose() { if (alive) { alive = false; unmount() } },
  }
}
