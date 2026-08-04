/**
 * 环境检测区(引导向导第③步与设置页共用):探测 node/npm/python/git/docker → 缺失项给
 * ①宿主白名单命令一键装(envRun,sudo 项改复制到剪贴板)②交给 Tangu 自己想办法装。
 *
 * 「让 Tangu 装」= 开新会话并**自动发送**一段中文指令(用户拍板要真·一键)。它比宿主那条写死的
 * 命令强在:能自己挑这台机器上真有的包管理器、能绕开需要交互式密码的 sudo 路径、装完自己验证。
 * 工具执行仍走引擎既有的审批闸,这里不额外放权。未连后端/没有可用模型时按钮不出现(装不了)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Bot, Check, Loader2, MonitorCheck, Play, RefreshCw, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { useWorkspace } from '@lcl/engine'
import type { EnvProbeResult } from '../types'

registerMessages({
  'env.askTangu': { zh: '让 Tangu 装', en: 'Let Tangu install' },
  'env.askTanguAll': { zh: '让 Tangu 装齐缺失项', en: 'Let Tangu install all missing' },
  'env.askTanguHint': {
    zh: '「让 Tangu 装」会新开一个对话并把安装任务交给它,命令执行仍需你按既有规则批准。',
    en: '"Let Tangu install" opens a new chat and hands the task to the agent; command execution still follows your existing approval rules.',
  },
})

/** 环境检测项 → 给 Tangu 的中文说明(工具名之外补一句用途,免得它装错东西)。 */
const TOOL_NOTE: Record<string, string> = {
  node: 'Node.js（含 npm）',
  npm: 'npm',
  python3: 'Python 3',
  git: 'Git',
  docker: 'Docker（代码沙箱用，可选）',
}

/** 缺失项 → 交给 Tangu 的安装指令。平台/镜像偏好都交代清楚,路子让它自己选。 */
export function buildInstallPrompt(tools: string[], platform: string, china: boolean): string {
  const list = tools.map((x) => TOOL_NOTE[x] || x).join('、')
  return [
    `帮我在这台电脑上装好开发环境。当前系统：${platform || '未知'}。缺少：${list}。`,
    '',
    '要求：',
    '1. 先看看这台机器上已经有哪些包管理器（brew / winget / scoop / apt / dnf / nvm / volta 等），挑一个真的可用的。',
    '2. **不要用需要交互式输入密码的 sudo 命令** —— 你没有终端可以输密码，会直接卡住。优先选装到用户目录、不需要提权的方式；实在只能提权，就把命令原样告诉我，我自己去终端跑。',
    china ? '3. 我在中国大陆，下载慢的话优先用国内镜像源（npmmirror、清华 TUNA 等）。' : '3. 直接用官方源即可。',
    '4. 装完逐个用 `--version` 验证，把结果报给我；有装不上的说清楚卡在哪一步。',
  ].join('\n')
}

export const EnvProbeSection: React.FC<{
  /** 交给 Tangu 后要离开当前面板(向导/设置)才看得到对话 —— 由调用方决定怎么关。 */
  onLeave?: () => void
}> = ({ onLeave }) => {
  const { t } = useI18n()
  const [probes, setProbes] = useState<EnvProbeResult[] | null>(null)
  const [envChecking, setEnvChecking] = useState(false)
  const [runningInstall, setRunningInstall] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  /** 最近一次「安装」的结果(行内反馈):ok=装上且复检到;missing=命令成功但复检仍缺;fail=exit≠0。 */
  const [installResult, setInstallResult] = useState<{ tool: string; state: 'ok' | 'missing' | 'fail'; version: string | null; exitCode: number } | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  // 平台名给 Tangu 当上下文(它据此选包管理器);window.tangu.platform 是 preload 注入的静态值。
  const platform = window.tangu?.platform || ''

  // Tangu 可用 = 后端连上了 且 有至少一个可用模型;否则发过去也只是开个必然失败的会话。
  const canAskTangu = useApp((s) => s.connState === 'ok' && (s.modelsResp?.models.length ?? 0) > 0)
  const mirrorChina = useApp((s) => (s.desktopConfig?.mirror || 'default') === 'china')

  const doEnvCheck = async (): Promise<EnvProbeResult[] | null> => {
    if (!window.tangu?.envCheck) return null
    setEnvChecking(true)
    try {
      const r = await window.tangu.envCheck()
      setProbes(r)
      return r
    } finally {
      setEnvChecking(false)
    }
  }

  useEffect(() => {
    void doEnvCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.tangu?.onEnvOutput?.((ev) => {
      setInstallLog((prev) => [...prev.slice(-400), ...ev.line.split('\n').filter(Boolean)])
      requestAnimationFrame(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight))
    })
    return () => off?.()
  }, [])

  const needsSudo = (p: EnvProbeResult): boolean => /^sudo\b/.test(p.installCommand || '')

  const runInstall = async (p: EnvProbeResult): Promise<void> => {
    if (!p.installId || !window.tangu?.envRun) return
    // sudo 命令需要 TTY 输密码,GUI 子进程里必然卡死/失败 → 改为复制命令请用户去终端执行。
    if (needsSudo(p)) {
      try { await navigator.clipboard.writeText(p.installCommand || '') } catch { /* ignore */ }
      setInstallLog((prev) => [...prev, t('onboarding.env.copied', { command: p.installCommand })])
      return
    }
    if (!window.confirm(t('onboarding.env.installConfirm', { command: p.installCommand }))) return
    setRunningInstall(p.installId)
    setInstallLog([])
    setInstallResult(null)
    try {
      const r = await window.tangu.envRun(p.installId)
      const after = await doEnvCheck() // 装完自动重测
      const probe = after?.find((x) => x.tool === p.tool)
      // 三态明示结果:exit 码 + 复检对比(exit 0 但复检仍缺 = PATH 未刷新/需重启,不能谎报成功)。
      setInstallResult({
        tool: p.tool,
        state: r.exitCode !== 0 ? 'fail' : probe?.found ? 'ok' : 'missing',
        version: probe?.version ?? null,
        exitCode: r.exitCode,
      })
    } finally {
      setRunningInstall(null)
    }
  }

  /** 交给 Tangu:新开会话直接发(targetSessionId=null 强制新会话,不污染当前对话)。 */
  const askTangu = (tools: string[]): void => {
    if (!tools.length) return
    const app = useApp.getState()
    void app.send(buildInstallPrompt(tools, platform, mirrorChina), [], undefined, undefined, undefined, null)
    useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
    onLeave?.()
  }

  // npm 跟随 node 装(主进程不给它独立安装命令)→ 缺 node 时不必单列 npm,免得 Tangu 装两遍。
  const missing = (probes ?? []).filter((p) => !p.found).map((p) => p.tool)
  const missingForTangu = missing.includes('node') ? missing.filter((x) => x !== 'npm') : missing

  return (
    <div className="field">
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <MonitorCheck size={13} /> {t('onboarding.env.stepLabel')}
        <span className="grow" />
        {canAskTangu && missingForTangu.length > 1 && (
          <button className="btn ghost sm" disabled={envChecking} onClick={() => askTangu(missingForTangu)}>
            <Bot size={12} /> {t('env.askTanguAll')}
          </button>
        )}
        <button
          className="btn ghost sm"
          disabled={envChecking || runningInstall !== null}
          onClick={() => void doEnvCheck()}
        >
          <RefreshCw size={12} className={envChecking ? 'spin' : ''} /> {t('onboarding.env.recheck')}
        </button>
      </label>
      {envChecking && <div className="hint">{t('onboarding.env.checking')}</div>}
      {probes?.map((pr) => (
        <React.Fragment key={pr.tool}>
          <div className="file-row" style={{ cursor: 'default' }}>
            <span className="file-name">
              {pr.found ? '✅' : '⚠️'} <b>{pr.tool}</b>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                {pr.found ? pr.version : pr.tool === 'docker' ? t('onboarding.env.missingDocker') : pr.tool === 'npm' ? t('onboarding.env.missingNpm') : t('onboarding.env.missing')}
              </span>
            </span>
            {!pr.found && canAskTangu && (
              <button className="btn ghost sm" disabled={runningInstall !== null} onClick={() => askTangu([pr.tool])}>
                <Bot size={12} /> {t('env.askTangu')}
              </button>
            )}
            {!pr.found && pr.installId && (
              <button
                className="btn ghost sm"
                disabled={runningInstall !== null}
                title={pr.installCommand || ''}
                onClick={() => void runInstall(pr)}
              >
                {runningInstall === pr.installId ? <Loader2 size={12} className="spin" /> : <Play size={12} />}{' '}
                {needsSudo(pr) ? t('onboarding.env.copyCmd') : t('onboarding.env.install')}
              </button>
            )}
          </div>
          {/* 安装结果三态行内反馈:成功(复检到)/命令成功但复检仍缺(PATH 未刷新)/失败(exit≠0)。 */}
          {installResult?.tool === pr.tool && (
            <div
              className="hint"
              style={{
                margin: '2px 0 6px', display: 'flex', alignItems: 'center', gap: 6,
                color: installResult.state === 'ok' ? 'var(--success, #22a06b)'
                  : installResult.state === 'fail' ? 'var(--danger, #e5484d)' : 'var(--text-muted)',
              }}
            >
              {installResult.state === 'ok' ? <Check size={12} /> : installResult.state === 'fail' ? <X size={12} /> : <RefreshCw size={12} />}
              {installResult.state === 'ok' && t('onboarding.env.installOk', { tool: installResult.tool, version: installResult.version || '' })}
              {installResult.state === 'missing' && t('onboarding.env.installedButMissing', { tool: installResult.tool })}
              {installResult.state === 'fail' && t('onboarding.env.installFail', { tool: installResult.tool, code: installResult.exitCode })}
            </div>
          )}
        </React.Fragment>
      ))}
      {installLog.length > 0 && (
        <pre
          ref={logRef}
          style={{
            marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', maxHeight: 160,
            overflowY: 'auto', background: 'var(--bg-card)', padding: 8,
            border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}
        >
          {installLog.join('\n')}
        </pre>
      )}
      <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.env.hint')}</div>
      {canAskTangu && !!missing.length && <div className="hint" style={{ marginTop: 4 }}>{t('env.askTanguHint')}</div>}
    </div>
  )
}
