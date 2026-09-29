/**
 * 正文生成式 AI 的渲染层客户端(评审 G3-07):流式请求引擎 `POST /agent/inline`(tangu-agent services/inlineAi.ts)。
 * 经 tanguProbe.complete 交给编辑器与插件(amadeus 那侧不许 import appStore,见 tanguSeam 顶注)。
 * SSE 读法照旁聊(btwStore.streamAside):经网关整段缓冲后一次到达也照样能解析,只是退化成非流式。
 */
import { registerMessages, translate } from '../i18n'
import { engineFetch, homeTarget } from './engine/targets'
import { AGENT_APP_ID, currentClientId } from './agentRunService'
import type { TanguCompleteOptions, TanguCompleteRequest, TanguCompleteResult } from '../amadeus/plugins/tanguSeam'

registerMessages({
  'inlineai.errUnsupported': { zh: '当前引擎版本不支持正文 AI，请更新 Tangu', en: 'This engine version does not support in-note AI. Update Tangu.' },
  'inlineai.errNoModel': { zh: '还没有可用的模型，先在聊天里选一个', en: 'No model is available yet. Pick one in the chat first.' },
  'inlineai.errEmpty': { zh: '模型没有返回内容', en: 'The model returned nothing' },
})

type InlineEvent = { type: 'delta'; text?: string } | { type: 'done'; content?: string; toolCallText?: boolean } | { type: 'error'; error?: string }

/** 引擎的机器码 → 人话:额度用尽与主聊天同一句(chat.err.quota)。 */
const readable = (raw: string): string => (/token_quota_exceeded/i.test(raw) ? translate('chat.err.quota') : raw)

export async function completeInline(req: TanguCompleteRequest, modelId: string | null, opts: TanguCompleteOptions = {}): Promise<TanguCompleteResult> {
  const model = req.modelId || modelId
  if (!model) throw new Error(translate('inlineai.errNoModel'))
  const { modelId: _drop, ...body } = req
  // 本端引擎(P1-K6:基址与鉴权头归目标解析层;正文 AI 只打本机,不跟会话走)
  const r = await engineFetch(homeTarget(), '/agent/inline', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model_id: model, app_id: AGENT_APP_ID, client: currentClientId() }),
  })
  if (!r.ok || !r.body) {
    const raw = await r.text().catch(() => '')
    let detail = ''
    try { detail = String(JSON.parse(raw)?.detail || '') } catch { /* 非 JSON = 老引擎没有这条路由(Express 的 Cannot POST 页) */ }
    throw new Error(r.status === 404 ? translate('inlineai.errUnsupported') : readable(detail || `HTTP ${r.status}`))
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done: TanguCompleteResult | null = null
  let error = ''
  const onEvent = (ev: InlineEvent): void => {
    if (ev.type === 'delta' && ev.text) opts.onDelta?.(ev.text)
    else if (ev.type === 'done') done = { text: String(ev.content ?? ''), toolCallText: !!ev.toolCallText }
    else if (ev.type === 'error') error = String(ev.error || 'error')
  }
  for (;;) {
    const { done: end, value } = await reader.read()
    if (end) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5))) } catch { /* 坏行跳过 */ }
    }
  }
  if (buf.startsWith('data:')) { try { onEvent(JSON.parse(buf.slice(5))) } catch { /* 坏尾行 */ } }
  if (error) throw new Error(readable(error))
  if (!done) throw new Error(translate('inlineai.errEmpty'))
  return done
}
