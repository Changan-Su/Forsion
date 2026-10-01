/** Isolated review fixture. Real shared ChatBox + real plugin registry/mount, with sample data.
 * Included only by FORSION_NATIVE_PREVIEW=1. No account, model requests or production data. */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageCircle, Layers, PenLine, Moon, Sun, Plus, ArrowUpRight, Paperclip, Mic, Globe } from 'lucide-react'
import { ChatBox, type ChatBoxSelection } from '@/components/chatbox'
import { useApp } from '@/stores/appStore'
import { usePluginStore } from '@/amadeus/plugins/pluginStore'
import type { AmadeusPlugin, ViewContribution } from '@/amadeus/plugins/types'
import { LocaleProvider } from '@/i18n'
import { LOCALE_KEY, type ModelInfo } from '@/types'
import '@/i18n.generated'
import { applyTheme } from '@/theme/loader'
import { installNativeModelPicker } from './nativeModelPicker'
import '@/styles/base.css'
import '@/views/chat2/composer2.css'
import './nativePreview.css'

const locale = new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh'
localStorage.setItem(LOCALE_KEY, locale)
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
const strings = {
  zh: { sample: '示例会话', chat: '聊天', notes: '笔记', plugins: '插件', theme: '切换外观', menu: '菜单', send: '发送', placeholder: '继续聊聊你的想法…',
    user: '帮我整理一下这次产品更新的重点。', title: '让想法，更进一步。', reply: '可以。我们可以围绕这三个方向展开，让每一项更新都对应清楚的使用场景。',
    items: ['更顺手的手机交互', '持续工作的 Agent', '可扩展的创作工具'], outro: '你想先从哪个方向开始？',
    pluginName: '写作助手', pluginHint: '把零散的灵感，整理成一篇好文章。', pluginLabel: '开始创作', pluginDraft: '写一段关于秋天的开场白', pluginInput: '描述你想写的内容…',
    outline: '产品更新 · 提纲', body: '手机上的每一次操作，都应该自然、轻快。', tag: '个人草稿', add: '添加附件', voice: '语音', disabled: '插件已停用', enable: '启用插件', disable: '停用插件',
    preview: 'Android 交互预览', pluginInfo: '此页面由示例插件创建', noteInfo: '编辑器沿用现有实现，本次未重写', language: 'English',
  },
  en: { sample: 'Sample conversation', chat: 'Chat', notes: 'Notes', plugins: 'Plugins', theme: 'Change appearance', menu: 'Menu', send: 'Send', placeholder: 'Keep exploring your idea…',
    user: 'Help me outline the highlights of this product update.', title: 'Take your ideas further.', reply: 'Of course. These three themes connect each improvement with a clear everyday use.',
    items: ['A more natural mobile experience', 'Agents that keep working', 'Extensible creative tools'], outro: 'Which direction would you like to start with?',
    pluginName: 'Writing assistant', pluginHint: 'Turn a collection of ideas into something worth reading.', pluginLabel: 'Start writing', pluginDraft: 'Write an opening paragraph about autumn', pluginInput: 'Describe what you want to write…',
    outline: 'Product update · Outline', body: 'Every interaction on your phone should feel natural and effortless.', tag: 'Personal draft', add: 'Add attachment', voice: 'Voice', disabled: 'Plugin disabled', enable: 'Enable plugin', disable: 'Disable plugin',
    preview: 'Android interaction preview', pluginInfo: 'This page is contributed by a sample plugin', noteInfo: 'The existing editor is retained and unchanged in this preview', language: '中文',
  },
}[locale]
const models: ModelInfo[] = [
  { id: 'sample-balanced', name: 'Claude Sonnet', provider: 'Anthropic', tags: [{ text: locale === 'zh' ? '均衡 · 写作与代码' : 'Balanced · Writing and code', color: 'blue' }] },
  { id: 'sample-deep', name: 'Claude Opus', provider: 'Anthropic', tags: [{ text: locale === 'zh' ? '深入推理' : 'Deep reasoning', color: 'blue' }] },
  { id: 'sample-gpt', name: 'GPT', provider: 'OpenAI', tags: [{ text: locale === 'zh' ? '分析与创作' : 'Analysis and creativity', color: 'green' }] },
  { id: 'sample-gemini', name: 'Gemini', provider: 'Google', tags: [{ text: locale === 'zh' ? '长文档与多模态' : 'Long documents and multimodal', color: 'green' }] },
].map(m => ({ ...m, tags: m.tags.map(tag => ({ ...tag, color: 'blue' as const })), source: 'forsion' as const, modelType: 'llm' as const, thinkingLevels: ['low', 'medium', 'high'], multiplier: 1 }))
useApp.setState({ modelsResp: { models, directProviders: [], defaultModelId: models[0].id } })
installNativeModelPicker()
const evidence = { chat: { modelId: models[0].id, thinkingLevel: 'medium' } as ChatBoxSelection, plugin: null as unknown, submitted: null as unknown }
const plugin: AmadeusPlugin = {
  id: 'native-preview-writing', name: '写作助手', nameEn: 'Writing assistant', version: '0.0.1',
  setup(ctx) {
    ctx.registerView({ id: 'writing', title: strings.pluginName, mount(el) {
      const intro = document.createElement('div'); intro.className = 'np-plugin-intro'
      const eyebrow = document.createElement('p'); eyebrow.className = 'np-eyebrow'; eyebrow.textContent = strings.pluginLabel
      const heading = document.createElement('h1'); heading.textContent = strings.pluginName
      const desc = document.createElement('p'); desc.textContent = strings.pluginHint
      intro.append(eyebrow, heading, desc)
      const input = document.createElement('div'); input.className = 'np-plugin-input'
      el.append(intro, input)
      const box = ctx.ui?.mountChatBox?.(input, {
        value: strings.pluginDraft, modelId: models[0].id, thinkingLevel: 'medium', label: strings.pluginInput,
        placeholder: strings.pluginInput, submitLabel: strings.send,
        onChange(draft) { evidence.plugin = { ...draft } },
        onSubmit(draft) { evidence.submitted = draft; return false },
      })
      return () => { box?.dispose(); el.replaceChildren() }
    } })
  },
}
usePluginStore.getState().init([plugin])

function PluginSurface({ def }: { def?: ViewContribution }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!def || !ref.current) return
    let disposed = false, cleanup: (() => void) | undefined
    void Promise.resolve(def.mount(ref.current)).then(fn => { if (typeof fn === 'function') { if (disposed) fn(); else cleanup = fn } })
    return () => { disposed = true; cleanup?.() }
  }, [def])
  return <div className="np-plugin" ref={ref} />
}

function Preview() {
  const [tab, setTab] = useState<'chat' | 'notes' | 'plugins'>('chat')
  const [mode, setMode] = useState<'light' | 'dark'>(() => new URLSearchParams(location.search).has('dark') ? 'dark' : 'light')
  const [draft, setDraft] = useState('')
  const [selection, setSelection] = useState(evidence.chat)
  const views = usePluginStore(s => s.views)
  const active = usePluginStore(s => s.activeIds.includes(plugin.id))
  useEffect(() => { applyTheme('lovable', 'teal', 'cream', mode); document.documentElement.style.colorScheme = mode }, [mode])
  useEffect(() => {
    ;(window as unknown as { __nativePreview: unknown }).__nativePreview = {
      evidence, setTab, setMode,
      disablePlugin: () => usePluginStore.getState().disable(plugin.id),
      enablePlugin: () => usePluginStore.getState().enable(plugin.id),
    }
  }, [])
  return <div className="np-app">
    <header className="np-header">
      <span className="np-brand"><img src="./Forsion-LOGO3.svg" alt="" />Forsion</span>
      <span className="np-header-actions">
        <button aria-label={strings.theme} onClick={() => setMode(mode === 'light' ? 'dark' : 'light')}>{mode === 'dark' ? <Sun size={20} /> : <Moon size={20} />}</button>
        <button aria-label={strings.language} onClick={() => { location.search = `?locale=${locale === 'zh' ? 'en' : 'zh'}${mode === 'dark' ? '&dark' : ''}` }}><Globe size={20} /></button>
      </span>
    </header>
    <main className="np-main">
      {tab === 'chat' && <>
        <div className="np-conversation-title"><span><MessageCircle size={16} />{strings.sample}</span><Plus size={19} /></div>
        <div className="np-messages">
          <div className="np-user">{strings.user}</div>
          <div className="np-assistant"><span className="np-eyebrow">Tangu</span><h2>{strings.title}</h2><p>{strings.reply}</p>
            <div className="np-topics">{strings.items.map((s, i) => <div key={s}><span>0{i + 1}</span><strong>{s}</strong><ArrowUpRight size={17} /></div>)}</div>
            <p>{strings.outro}</p>
          </div>
        </div>
        <div className="np-composer"><ChatBox value={draft} onValueChange={setDraft} selection={selection} onSelectionChange={value => { evidence.chat = value; setSelection(value) }}
          onSubmit={() => { evidence.submitted = { ...selection, text: draft } }} submitLabel={strings.send} submitDisabled={!draft.trim()}
          inputProps={{ placeholder: strings.placeholder, 'aria-label': strings.placeholder }}
          controls={<><Paperclip size={17} /><Mic size={17} /></>} /></div>
      </>}
      {tab === 'plugins' && <>
        <div className="np-conversation-title"><span><Layers size={16} />{strings.plugins}</span><button onClick={() => active ? usePluginStore.getState().disable(plugin.id) : usePluginStore.getState().enable(plugin.id)}>{active ? strings.disable : strings.enable}</button></div>
        {active ? <PluginSurface def={views.find(v => v.pluginId === plugin.id)?.item} /> : <p className="np-muted">{strings.disabled}</p>}
        <p className="np-disclosure">{strings.pluginInfo}</p>
      </>}
      {tab === 'notes' && <div className="np-note"><span className="np-eyebrow">{strings.tag}</span><h1>{strings.outline}</h1><p>{strings.body}</p><p className="np-muted">{strings.noteInfo}</p></div>}
    </main>
    <nav className="np-nav" aria-label={strings.preview}>
      {([['chat', MessageCircle], ['notes', PenLine], ['plugins', Layers]] as const).map(([id, Icon]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={21} /><span>{strings[id]}</span></button>)}
    </nav>
  </div>
}
createRoot(document.getElementById('root')!).render(<LocaleProvider><Preview /></LocaleProvider>)
