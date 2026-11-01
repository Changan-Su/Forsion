/**
 * 正文生成式 AI 的渲染层客户端(评审 G3-07):流式请求引擎 `POST /agent/inline`(tangu-agent services/inlineAi.ts)。
 * 经 tanguProbe.complete 交给编辑器与插件(amadeus 那侧不许 import appStore,见 tanguSeam 顶注)。
 * SSE 读法照旁聊(btwStore.streamAside):经网关整段缓冲后一次到达也照样能解析,只是退化成非流式。
 */
import { registerMessages, translate } from '../i18n'
import { engineFetch, homeTarget } from './engine/targets'
import { AGENT_APP_ID, currentClientId } from './agentRunService'
import { protectTranslation } from './translationContent'
import type { TanguCompleteOptions, TanguCompleteRequest, TanguCompleteResult, TanguFimRequest } from '../amadeus/plugins/tanguSeam'

registerMessages({
  'inlineai.errUnsupported': { zh: '当前引擎版本不支持正文 AI，请更新 Tangu', en: 'This engine version does not support in-note AI. Update Tangu.' },
  'inlineai.errNoModel': { zh: '还没有可用的模型，先在聊天里选一个', en: 'No model is available yet. Pick one in the chat first.' },
  'inlineai.errEmpty': { zh: '模型没有返回内容', en: 'The model returned nothing' },
  'inlineai.errFormat': { zh: '译文中的公式或格式内容未完整保留，请重试。原文未改动。', en: 'The translation did not preserve all formulas or formatting. Please retry. The original is unchanged.' },
  'inlineai.errTooLong': { zh: '选中的内容过长，请分段翻译', en: 'The selection is too long. Please translate it in smaller sections.' },
})

type InlineEvent = { type: 'delta'; text?: string } | { type: 'done'; content?: string; toolCallText?: boolean } | { type: 'error'; error?: string }

/** 引擎的机器码 → 人话:额度用尽与主聊天同一句(chat.err.quota)。 */
const readable = (raw: string): string => (/token_quota_exceeded/i.test(raw) ? translate('chat.err.quota') : raw)

export async function completeInline(req: TanguCompleteRequest, modelId: string | null, opts: TanguCompleteOptions = {}): Promise<TanguCompleteResult> {
  const model = req.modelId || modelId
  if (!model) throw new Error(translate('inlineai.errNoModel'))
  const { modelId: _drop, ...body } = req
  if (req.action === 'translate' && req.selection) {
    const content = protectTranslation(req.selection)
    // The engine caps selection at 20,000 characters. Never let that cap cut a source span or marker in half.
    if (content.text.length > 20_000) throw new Error(translate('inlineai.errTooLong'))
    if (content.protected) {
      // Buffer protected translations: neither partial markers nor a failed attempt may become copyable/applicable.
      // Plain prose keeps streaming. A format failure gets one retry on the same explicitly selected model.
      for (let attempt = 0; attempt < 2; attempt++) {
        opts.signal?.throwIfAborted()
        const result = await streamInline({ ...body, selection: content.text }, model, { signal: opts.signal })
        opts.signal?.throwIfAborted()
        const text = content.restore(result.text)
        if (text != null) { opts.onDelta?.(text); return { ...result, text } }
      }
      throw Object.assign(new Error(translate('inlineai.errFormat')), { code: 'translation_format_lost' })
    }
  }
  return streamInline(body, model, opts)
}

/** 引擎 / 云端做不了 FIM(老引擎不认 fim 动作 → 400,没这条路由 → 404,模型不支持 → error 事件 fim_unsupported):
 *  一律报成机器码 `fim_unavailable`,插件据此落回 complete。 */
export const FIM_UNAVAILABLE = 'fim_unavailable'

/** 行内补全(FIM):engine `/agent/inline` 的 fim 动作。模型由调用方解析好(tanguProbe.fimModelChoice);返回模型原文。 */
export async function fimInline(req: TanguFimRequest, modelId: string, opts: TanguCompleteOptions = {}): Promise<{ text: string }> {
  const body = {
    action: 'fim',
    before: req.before,
    ...(req.after ? { after: req.after } : {}),
    ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
    ...(req.stop?.length ? { stop: req.stop } : {}),
  }
  try {
    return { text: (await streamInline(body, modelId, opts)).text }
  } catch (e: any) {
    if (opts.signal?.aborted) throw e
    if (e?.status === 400 || e?.status === 404 || e?.code === 'fim_unsupported') throw new Error(FIM_UNAVAILABLE)
    throw e
  }
}

/** 发一次 /agent/inline 并读完 SSE。抛出的 Error 带 `status`(HTTP 非 2xx)或 `code`(error 事件的原始机器码)。 */
async function streamInline(body: object, model: string, opts: TanguCompleteOptions): Promise<TanguCompleteResult> {
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
    throw Object.assign(new Error(r.status === 404 ? translate('inlineai.errUnsupported') : readable(detail || `HTTP ${r.status}`)), { status: r.status })
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
  if (error) throw Object.assign(new Error(readable(error)), { code: error })
  if (!done) throw new Error(translate('inlineai.errEmpty'))
  return done
}
