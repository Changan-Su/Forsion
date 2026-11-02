/** Real Composer2 / ModelPill / AddContentMenu, with isolated local fixture state. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import './views/chat2/composer2.css'
import './views/chat2/chat2.css'
import { Composer2 } from './views/chat2/Composer2'
import { ChatBox } from './components/chatbox'
import { applyTheme } from './theme/loader'
import type { AgentConfig, ModelInfo, ModelsResponse, NormalAgentDef } from './types'
import './tangu/store/standalone'

const q = new URLSearchParams(location.search)
setLocaleGlobal(q.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', q.get('skin') || 'cream', q.get('skin') || 'cream', q.has('light') ? 'light' : 'dark')
document.body.style.zoom = q.get('zoom') || '1'
const models = [
  { id: 'gpt-6-luna', name: 'gpt-6-luna', provider: 'codex', source: 'direct', contextWindow: 272000, fastTier: '1.5x speed', thinkingLevels: ['low', 'medium', 'high', 'max'] },
  { id: 'long', name: 'Research / Very long model deployment with spaces and 0123456789', provider: 'codex', source: 'direct', contextWindow: 272000 },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}`, provider: 'codex', source: 'direct', contextWindow: 272000 })),
] as ModelInfo[]
const catalog = { models, backgroundModelId: '', imageModelId: '', visionModelId: '' } as ModelsResponse
const agents = [{ slug: 'arioso', name: 'Arioso' }, { slug: 'research', name: 'Research assistant with a long display name' }] as NormalAgentDef[]
type State = { width: number; height: number; running: boolean; model: string; approval: AgentConfig['approvalMode']; loaded: boolean }
const initial: State = { width: 320, height: 720, running: false, model: 'gpt-6-luna', approval: 'auto-edit', loaded: false }
declare global { interface Window { __narrow: { set(patch: Partial<State>): void; sent: string[]; stopped: number } } }
window.__narrow = { set() {}, sent: [], stopped: 0 }
function Harness() {
  const [state, set] = useState(initial)
  const [level, setLevel] = useState<NonNullable<AgentConfig['thinkingLevel']>>('medium')
  const [fast, setFast] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [selection, setSelection] = useState({ modelId: 'gpt-6-luna', thinkingLevel: 'medium' as NonNullable<AgentConfig['thinkingLevel']> })
  window.__narrow.set = patch => set(prev => ({ ...prev, ...patch }))
  return <div className="t2-chat-view" style={{ display: 'flex', position: 'absolute', left: 24, top: 48, width: state.width, height: state.height, background: 'var(--sidebar-bg)', borderRadius: 12 }}>
    <div className="t2-chat-col">
      <div className="t2-chat-body" style={{ padding: 20 }}>ARIOSO<br /><br />窄 Chat View / Compact Chat View<br />ZZ-验收4-画布.md</div>
      <div className="composer-anchor">
        {q.has('prompt') ? <div className="t2c-inner"><ChatBox value={prompt} onValueChange={setPrompt} onSubmit={() => {}}
          submitLabel="Submit" selection={selection} onSelectionChange={setSelection} /></div> : <Composer2
          sessionId={null} disabled={false} running={state.running} liveOwner={false}
          execConfig={{ execMode: 'host', approvalMode: state.approval }}
          engineId={q.has('engine') ? 'acp' : undefined} engineModels={state.loaded ? models : []} engineModelId={state.model} onEngineModelChange={model => set(prev => ({ ...prev, model }))}
          models={models} modelsResponse={catalog} modelId={state.model} onModelChange={model => set(prev => ({ ...prev, model }))}
          thinkingLevel={level} onThinkingChange={setLevel} fast={fast} onFastChange={setFast}
          onDefaultModelChange={() => {}} onNormalWork={() => {}} agents={agents} currentAgentSlug="arioso" onAgentSwitch={() => {}}
          contextWindow={272000} ctxTokens={49700} sessionTokens={49700}
          onExecConfigChange={config => set(prev => ({ ...prev, approval: config.approvalMode }))}
          onSend={async text => { window.__narrow.sent.push(text); return true }}
          onStop={() => { window.__narrow.stopped++; set(prev => ({ ...prev, running: false })) }}
        />}
      </div>
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<LocaleProvider><Harness /></LocaleProvider>)
