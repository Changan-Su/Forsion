import type { TanguProbe, TanguStartChatResult } from '../amadeus/plugins/tanguSeam'
import { stickyDefaults, useApp, withAmadeusWorkspace } from '../stores/appStore'
import { settleUltra } from '../stores/projectSettings'
import { createSession } from './backendService'
import { bindSession, connectionKey, homeTarget } from './engine/targets'
import { registerMessages, translate } from '../i18n'

registerMessages({
  'documentTask.unavailable': { zh: '当前环境不支持笔记任务', en: 'Note tasks are unavailable in this environment' },
  'documentTask.sourceGone': { zh: '原任务块已改变，请回到笔记重新交办', en: 'The source task changed. Return to the note to submit it again.' },
  'documentTask.duplicate': { zh: '任务标识已用于其他内容，请重新插入任务块', en: 'This task ID belongs to different content. Insert a new task block.' },
  'documentTask.noModel': { zh: '请先选择可用模型', en: 'Select an available model first' },
  'documentTask.unknownAgent': { zh: '所选 Agent 已不存在', en: 'The selected Agent is no longer available' },
  'documentTask.sendFailed': { zh: '发送未确认，请打开关联会话查看后继续', en: 'Sending was not confirmed. Open the linked conversation before continuing.' },
  'documentTask.busy': { zh: '另一窗口正在交办此任务，请稍后查看关联会话', en: 'Another window is submitting this task. Check its linked conversation shortly.' },
})

type Request = Parameters<NonNullable<TanguProbe['submitDocumentTask']>>[0]
type Entry = { signature: string; promise: Promise<TanguStartChatResult>; sessionId?: string }
// Same-renderer callers join this promise. The main-process claim arbitrates across windows.
const submissions = new Map<string, Entry>()
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
}

export async function submitDocumentTask(o: Request, modelId: string | null): Promise<TanguStartChatResult> {
  if (!o.alive()) return { ok: false, error: translate('documentTask.sourceGone') }
  const host = typeof window !== 'undefined' ? window.tangu?.documentTasks : undefined
  if (!host) return { ok: false, error: translate('documentTask.unavailable') }
  const identity = (): string => {
    const st = useApp.getState()
    return `${connectionKey(st.cfg)}:${JSON.stringify([st.authInfo?.cloudUrl, st.authInfo?.accountId])}`
  }
  const origin = identity()
  const key = `${origin}\n${o.key}` // Private, in-memory only; never log connection credentials.
  const initial = useApp.getState()
  // Managed ports/tokens rotate on restart. They guard live work, but cannot identify a durable receipt.
  const realm = JSON.stringify([
    initial.desktopConfig?.mode === 'managed' ? 'managed' : connectionKey(initial.cfg, () => ''), // 不带令牌的连接身份;基址只经目标解析层取(棘轮 R1)
    initial.authInfo?.cloudUrl ?? '', initial.authInfo?.accountId ?? '',
  ])
  const signature = JSON.stringify([o.agent ?? '', o.prompt, o.vaultRoot])
  const existing = submissions.get(key)
  if (existing) {
    if (existing.signature !== signature) return { ok: false, error: translate('documentTask.duplicate') }
    const result = await existing.promise
    if (result.sessionId && o.alive() && identity() === origin) await o.onCreated(result.sessionId)
    return result
  }
  const entry: Entry = { signature, promise: Promise.resolve({ ok: false }) }
  submissions.set(key, entry)
  let invalidated = false
  const off = useApp.subscribe(() => { if (identity() !== origin) invalidated = true })
  const alive = (): boolean => !invalidated && identity() === origin && o.alive()
  let hostKey: string | undefined
  let claimToken: string | undefined
  entry.promise = (async () => {
    const app = useApp.getState()
    const agent = o.agent ? app.agentDefs.find((a) => a.slug === o.agent) : undefined
    if (o.agent && !agent) return { ok: false, error: translate('documentTask.unknownAgent') }
    const model = agent?.model || modelId
    if (!model) return { ok: false, error: translate('documentTask.noModel') }
    if (!o.prompt.trim() || o.prompt.length > 32_000 || !/^(?:\/|[A-Za-z]:[\\/])/.test(o.vaultRoot)) {
      return { ok: false, error: translate('documentTask.unavailable') }
    }
    // Persist only digests of connection identity and content, never credentials or prompts.
    const [hashedKey, hashedSignature] = await Promise.all([digest(`${realm}\n${o.key}`), digest(signature)])
    if (!alive()) return { ok: false, error: translate('documentTask.sourceGone') }
    hostKey = hashedKey
    const claim = await host.claim(hashedKey, hashedSignature)
    if (claim.state === 'conflict') return { ok: false, error: translate('documentTask.duplicate') }
    if (claim.state === 'busy') return { ok: false, error: translate('documentTask.busy') }
    if (claim.state === 'linked') {
      if (!alive()) return { ok: false, error: translate('documentTask.sourceGone') }
      entry.sessionId = claim.sessionId
      await o.onCreated(claim.sessionId)
      return { ok: true, sessionId: claim.sessionId }
    }
    claimToken = claim.token
    if (!alive()) return { ok: false, error: translate('documentTask.sourceGone') }
    const config = settleUltra(withAmadeusWorkspace({
      ...stickyDefaults(app.desktopConfig, true), execMode: 'host', cwd: o.vaultRoot,
      ...(o.agent ? { agentSlug: o.agent } : {}),
      ...(agent?.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    }, o.vaultRoot))
    const target = homeTarget()
    const session = await createSession(target, {
      title: o.prompt.split('\n')[0].slice(0, 80), model_id: model,
      project_path: o.vaultRoot, project_name: o.vaultRoot.split(/[\\/]/).filter(Boolean).pop(), agent_config: config,
    })
    if (!alive()) return { ok: false, error: translate('documentTask.sourceGone') }
    bindSession(session.id, { kind: 'home' })
    useApp.getState().adoptSession(session, { fresh: true })
    if (!alive()) return { ok: false, error: translate('documentTask.sourceGone') }
    // The callback verifies block identity and strict CAS persistence. No run exists before this resolves.
    await o.onCreated(session.id)
    entry.sessionId = session.id
    if (!alive()) return { ok: false, sessionId: session.id, error: translate('documentTask.sourceGone') }
    // A durable receipt consumes the claim before sending. Uncertain sends are never auto-retried.
    await host.complete(hashedKey, claim.token, session.id)
    if (!alive()) return { ok: false, sessionId: session.id, error: translate('documentTask.sourceGone') }
    const sent = await useApp.getState().send(o.prompt, [], undefined, undefined, undefined, session.id)
    return { ok: sent, sessionId: session.id, ...(!sent ? { error: translate('documentTask.sendFailed') } : {}) }
  })().catch((e: unknown) => ({ ok: false, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), error: e instanceof Error ? e.message : String(e) }))
    .finally(async () => { if (hostKey && claimToken) await host.release(hostKey, claimToken).catch(() => {}) })
  const result = await entry.promise
  off()
  if (!entry.sessionId) submissions.delete(key)
  return result
}
