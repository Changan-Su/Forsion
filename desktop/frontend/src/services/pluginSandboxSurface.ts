/**
 * 插件沙箱的客户端能力面(ns `plugin`,能力 `plugin.sandbox`;契约 tangu-agent/docs/plugin-sandbox.md)。
 *
 * 引擎的 plugin_sandbox / plugin_sandbox_inspect 发 `client_cmd` → 这里 claim → 主进程起停沙箱 / 截图 / 读状态 → result。
 * 与手机那边(phone-control.md §5)不同,桌面上**由渲染层回执**:动作在主进程做,渲染层与主进程同属这台机器上
 * 被信任的宿主,没有「JS 是不受信搬运工」那层顾虑。引擎 pending 表照样是唯一权威:claim 不到 nonce 就什么都不做。
 *
 * 只有用户那份桌面 Forsion 有 window.tangu.pluginSandbox(沙箱自己、web、mobile 都没有)→ 不注册 = 不声明能力 = 工具不出现。
 */
import { registerClientSurface } from './clientSurfaces'
import { postClientAction } from './agentRunService'
import { targetForSession } from './engine/targets'
import { PLUGIN_SANDBOX_CAPABILITY, PLUGIN_SANDBOX_NS, isSandboxOp } from '../../../../tangu-agent/src/contracts/pluginSandbox'
import { registerMessages, translate } from '../i18n'

registerMessages({
  'sandbox.reportDraft': { zh: '我在沙箱里试「{name}」，发现：{note}', en: 'I tried "{name}" in the sandbox and found: {note}' },
})

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const claimantId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** 沙箱跟着用户这边的外观:主题那几把键随每次调用带过去(主进程只留 forsion_theme* / forsion_glass*)。 */
export function sandboxUiStorage(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && /^forsion_(theme|glass)/.test(k)) out[k] = localStorage.getItem(k) ?? ''
    }
  } catch { /* 读不到就用沙箱自己的缺省外观 */ }
  return out
}

export function installPluginSandboxSurface(): void {
  const api = window.tangu?.pluginSandbox
  if (!api) return
  // 沙箱窗口里点「报告问题」:回到发起这个沙箱的对话,把话放进输入框(用户自己决定发不发)
  api.onReport((r) => {
    void Promise.all([import('../sessionNav'), import('../stores/appStore')]).then(([nav, { useApp }]) => {
      if (r.sessionId) nav.openSession(r.sessionId)
      useApp.getState().setPendingDraft(translate('sandbox.reportDraft', { name: r.name, note: r.note }))
    })
  })
  registerClientSurface(PLUGIN_SANDBOX_NS, {
    capabilities: () => [PLUGIN_SANDBOX_CAPABILITY],
    async exec({ runId, ackId, body }) {
      let cmd: { runId?: unknown; sessionId?: unknown; ackId?: unknown; ns?: unknown; op?: unknown; args?: unknown }
      try { cmd = JSON.parse(body) } catch { return }
      // 与 G2 / G3 同理只是早筛:body 不是给这条 run / 这个 ack 的就不 claim(claim 会 410)
      if (cmd.runId !== runId || cmd.ackId !== ackId || cmd.ns !== PLUGIN_SANDBOX_NS) return
      const sessionId = typeof cmd.sessionId === 'string' ? cmd.sessionId : undefined
      const target = targetForSession(sessionId)
      const claim = await postClientAction(target, runId, ackId, { phase: 'claim', digest: await sha256Hex(body), claimant: claimantId() })
      const nonce = typeof claim?.nonce === 'string' ? claim.nonce : ''
      if (!nonce) return
      const deadline = Date.now() + Math.min(typeof claim?.execMs === 'number' ? claim.execMs : 20_000, 120_000)
      const args = cmd.args && typeof cmd.args === 'object' && !Array.isArray(cmd.args) ? cmd.args as Record<string, unknown> : {}
      const r = isSandboxOp(cmd.op)
        ? await api.exec(cmd.op, args, { sessionId, deadline, ui: { storage: sandboxUiStorage() } }).catch((e: unknown) => ({ ok: false, code: 'error', error: e instanceof Error ? e.message : String(e) }))
        : { ok: false, code: 'unsupported', error: `unknown sandbox action "${String(cmd.op)}"` }
      // 过了引擎的期限:引擎已按 no_report(可能已发生)兑现,再回只会 410
      if (Date.now() > deadline) return
      await postClientAction(target, runId, ackId, { phase: 'result', nonce, ...r })
    },
  })
}
