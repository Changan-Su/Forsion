/**
 * 本机工具检测区(首启向导「本机环境」步与设置 → 常规设置 → 本机运行环境共用):探测 node/npm/python/git/docker/tangu → 缺失项给
 * ①宿主白名单命令一键装(envRun,sudo 项改复制到剪贴板)②交给 Tangu 自己想办法装。
 *
 * 「让 Tangu 装」= 开新会话并**自动发送**一段中文指令(用户拍板要真·一键)。它比宿主那条写死的
 * 命令强在:能自己挑这台机器上真有的包管理器、能绕开需要交互式密码的 sudo 路径、装完自己验证。
 * 工具执行仍走引擎既有的审批闸,这里不额外放权。未连后端/没有可用模型时按钮不出现(装不了)。
 *
 * 安装命令按**检测那一刻**配置里的下载源生成(main.ts runEnvCheck)—— 换源后调用方要重挂本组件(改 key)
 * 让它重测,否则「安装」跑的还是旧源的命令。
 */
import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, Bot, Check, CheckCircle2, CircleDashed, Loader2, Play, RefreshCw, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { useWorkspace } from '@lcl/engine'
import type { EnvProbeResult } from '../types'
import './envProbe.css'

registerMessages({
  'env.askTangu': { zh: '让 Tangu 装', en: 'Let Tangu install' },
  'env.askTanguAll': { zh: '让 Tangu 装齐缺失项', en: 'Let Tangu install all missing' },
  'env.askTanguHint': {
    zh: '「让 Tangu 装」会新开一个对话并把安装任务交给它，命令执行仍需你按既有规则批准。',
    en: '"Let Tangu install" opens a new chat and hands the task to the agent; command execution still follows your existing approval rules.',
  },
  'env.summaryReady': { zh: '{count} 项工具均已就绪', en: 'All {count} tools are ready' },
  'env.summaryMissing': { zh: '{count} 项未检测到', en: '{count} not detected' },
  'env.checkFailed': { zh: '检测失败:{error}', en: 'Check failed: {error}' },
  'env.bundled': { zh: '内置', en: 'Bundled' },
  'env.optional': { zh: '可选', en: 'Optional' },
  'env.withNode': { zh: '随 Node.js 安装', en: 'Installed with Node.js' },
  'env.autoInstall': { zh: '下次启动时自动安装', en: 'Installs automatically on next launch' },
  'env.sudoHint': { zh: '需要系统密码的命令会复制到剪贴板，请在终端中运行。', en: 'Commands that need your system password are copied for you to run in Terminal.' },
  'env.purpose.node': { zh: '运行本机编码工具与 MCP 服务', en: 'Runs local coding tools and MCP servers' },
  'env.purpose.npm': { zh: '安装 Node 软件包', en: 'Installs Node packages' },
  'env.purpose.python3': { zh: '运行数据处理与脚本任务', en: 'Runs data and scripting tasks' },
  'env.purpose.git': { zh: '克隆项目并管理版本', en: 'Clones projects and tracks changes' },
  'env.purpose.docker': { zh: '隔离运行 Python 代码', en: 'Runs Python code in isolation' },
  'env.purpose.tangu': { zh: '在终端中使用 tangu 命令', en: 'Use the tangu command in Terminal' },
})

/** 探测项 id → 展示名(产品名,不翻译)。 */
const TOOL_LABEL: Record<string, string> = {
  node: 'Node.js', npm: 'npm', python3: 'Python', git: 'Git', docker: 'Docker', tangu: 'Tangu CLI',
}
/** 缺了也不影响主流程的工具(只标注,不改变检测结论)。 */
const OPTIONAL_TOOLS = new Set(['docker'])
/** App 每次启动自愈安装的(main.ts ensureCliInstalled):只报告,不给「安装 / 让 Tangu 装」。 */
const SELF_HEALING = new Set(['tangu'])

/** 版本串收敛成一个号(`git version 2.50.1 (Apple Git-155)` → `2.50.1`);完整原文放 title。 */
function shortVersion(version: string): string {
  return version.replace(/ · bundled$/, '').match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? version.replace(/ · bundled$/, '')
}

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
  /** 调用方正在改会影响安装的配置(如向导换源存盘中):锁住全部动作,等它落定后调用方会重挂本组件。 */
  locked?: boolean
}> = ({ onLeave, locked = false }) => {
  const { t } = useI18n()
  const [probes, setProbes] = useState<EnvProbeResult[] | null>(null)
  const [envChecking, setEnvChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  const [runningInstall, setRunningInstall] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  /** 最近一次「安装」的结果(行内反馈):ok=装上且复检到;missing=命令成功但复检仍缺;fail=exit≠0。 */
  const [installResult, setInstallResult] = useState<{ tool: string; state: 'ok' | 'missing' | 'fail'; version: string | null; exitCode: number } | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  // 平台名给 Tangu 当上下文(它据此选包管理器);window.tangu.platform 是 preload 注入的静态值。
  const platform = window.tangu?.platform || ''

  // 后端模式从宿主配置读(检测时读一次决定显不显示,点「让 Tangu 装」时再读一次决定发不发、用哪个源)。
  // 别用 appStore.desktopConfig:它只在启动/后端就绪时刷新,引导或设置刚换的源它还不知道(Codex 评审)。
  const [host, setHost] = useState<{ managed: boolean } | null>(null)
  // Tangu 可用 = 后端连上了 且 有至少一个可用模型 且 是本机托管后端;外部后端可能在别的机器上,
  // 交给它装的是那台机器(Codex 评审 P1)—— 此时只给宿主那条本机命令。
  const connected = useApp((s) => s.connState === 'ok' && (s.modelsResp?.models.length ?? 0) > 0)
  const canAskTangu = connected && !!host?.managed
  // 读配置那一下是异步的:期间被锁(向导开始换源)或被卸载,点击就作废;读的过程中也不接第二次点击。
  const [asking, setAsking] = useState(false)
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const doEnvCheck = async (): Promise<EnvProbeResult[] | null> => {
    if (!window.tangu?.envCheck) return null
    setEnvChecking(true)
    setCheckError('')
    try {
      const [r, cfg] = await Promise.all([window.tangu.envCheck(), window.tangu.getConfig?.().catch(() => null)])
      setProbes(r)
      if (cfg) setHost({ managed: cfg.mode === 'managed' })
      return r
    } catch (e) {
      // 吞掉 = 列表静默为空(2.11.4 前就是这样,看起来像「检测功能没了」);显式报出来。
      setCheckError(e instanceof Error ? e.message : String(e))
      return null
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
    if (!p.installId || !window.tangu?.envRun || locked) return
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

  /** 交给 Tangu:新开会话直接发(targetSessionId=null 强制新会话,不污染当前对话)。
   *  点下去那一刻再读一次宿主配置:挂载期间别处(另一扇窗)把后端换成外部的,不能照旧往外发(Codex 评审)。 */
  const askTangu = async (tools: string[]): Promise<void> => {
    if (!tools.length || locked || asking) return
    setAsking(true)
    try {
      const cfg = await window.tangu?.getConfig?.().catch(() => null)
      if (!alive.current || lockedRef.current) return
      if (!cfg || cfg.mode !== 'managed') { void doEnvCheck(); return }
      const app = useApp.getState()
      void app.send(buildInstallPrompt(tools, platform, cfg.mirror === 'china'), [], undefined, undefined, undefined, null)
      useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      onLeave?.()
    } finally {
      if (alive.current) setAsking(false)
    }
  }

  // npm 跟随 node 装(主进程不给它独立安装命令)→ 缺 node 时不必单列 npm,免得 Tangu 装两遍。
  const missing = (probes ?? []).filter((p) => !p.found).map((p) => p.tool)
  const missingForTangu = (missing.includes('node') ? missing.filter((x) => x !== 'npm') : missing).filter((x) => !SELF_HEALING.has(x))
  const summary = checkError ? t('env.checkFailed', { error: checkError })
    : !probes ? t('onboarding.env.checking')
      : missing.length ? t('env.summaryMissing', { count: missing.length }) : t('env.summaryReady', { count: probes.length })

  return (
    <div className="env-probe" aria-busy={envChecking}>
      <div className="env-probe-head">
        <span className={`env-probe-summary${checkError ? ' is-error' : missing.length ? ' is-missing' : ''}`} role="status">
          {envChecking ? <Loader2 size={14} className="spin" /> : checkError || missing.length ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
          {summary}
        </span>
        {canAskTangu && missingForTangu.length > 1 && (
          <button className="btn ghost sm" disabled={locked || asking || envChecking} onClick={() => void askTangu(missingForTangu)}>
            <Bot size={12} /> {t('env.askTanguAll')}
          </button>
        )}
        <button className="btn ghost sm" disabled={locked || envChecking || runningInstall !== null} onClick={() => void doEnvCheck()}>
          <RefreshCw size={12} className={envChecking ? 'spin' : ''} /> {t('onboarding.env.recheck')}
        </button>
      </div>
      {probes && (
        <ul className="env-probe-list">
          {probes.map((pr) => {
            const optional = OPTIONAL_TOOLS.has(pr.tool)
            const bundled = !!pr.version?.endsWith(' · bundled')
            const state = pr.found ? 'ok' : optional ? 'optional' : 'missing'
            return (
              <li key={pr.tool} className="env-probe-row" data-tool={pr.tool} data-state={state}>
                <span className="env-probe-icon" aria-hidden="true">
                  {pr.found ? <CheckCircle2 size={16} /> : optional ? <CircleDashed size={16} /> : <AlertCircle size={16} />}
                </span>
                <span className="env-probe-name">
                  <strong>{TOOL_LABEL[pr.tool] || pr.tool}</strong>
                  {/* 用途键是拼出来的,i18nCoverage 扫不到:主进程新增探测项没配文案时宁可不显示,也别把 key 渲出来。 */}
                  {TOOL_LABEL[pr.tool] && <small>{t(`env.purpose.${pr.tool}`)}</small>}
                </span>
                <span className="env-probe-version" title={pr.version || undefined}>
                  {pr.found && pr.version ? <>
                    {shortVersion(pr.version)}{bundled && <em>{t('env.bundled')}</em>}
                  </> : pr.found ? null : pr.tool === 'npm' ? t('env.withNode') : SELF_HEALING.has(pr.tool) ? t('env.autoInstall') : <>
                    {t('onboarding.env.missing')}{optional && <em>{t('env.optional')}</em>}
                  </>}
                </span>
                {!pr.found && !SELF_HEALING.has(pr.tool) && (canAskTangu || pr.installId) && (
                  <span className="env-probe-actions">
                    {canAskTangu && (
                      <button className="btn ghost sm" disabled={locked || asking || runningInstall !== null} onClick={() => void askTangu([pr.tool])}>
                        <Bot size={12} /> {t('env.askTangu')}
                      </button>
                    )}
                    {pr.installId && (
                      <button
                        className="btn ghost sm"
                        disabled={locked || runningInstall !== null}
                        title={pr.installCommand || ''}
                        onClick={() => void runInstall(pr)}
                      >
                        {runningInstall === pr.installId ? <Loader2 size={12} className="spin" /> : <Play size={12} />}{' '}
                        {needsSudo(pr) ? t('onboarding.env.copyCmd') : t('onboarding.env.install')}
                      </button>
                    )}
                  </span>
                )}
                {/* 安装结果三态行内反馈:成功(复检到)/命令成功但复检仍缺(PATH 未刷新)/失败(exit≠0)。 */}
                {installResult?.tool === pr.tool && (
                  <span className="env-probe-result" data-state={installResult.state}>
                    {installResult.state === 'ok' ? <Check size={12} /> : installResult.state === 'fail' ? <X size={12} /> : <RefreshCw size={12} />}
                    {installResult.state === 'ok' && t('onboarding.env.installOk', { tool: installResult.tool, version: installResult.version || '' })}
                    {installResult.state === 'missing' && t('onboarding.env.installedButMissing', { tool: installResult.tool })}
                    {installResult.state === 'fail' && t('onboarding.env.installFail', { tool: installResult.tool, code: installResult.exitCode })}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {installLog.length > 0 && <pre ref={logRef} className="env-probe-log">{installLog.join('\n')}</pre>}
      {missingForTangu.length > 0 && <p className="env-probe-hint">{t('env.sudoHint')}</p>}
      {missingForTangu.length > 0 && canAskTangu && <p className="env-probe-hint">{t('env.askTanguHint')}</p>}
    </div>
  )
}
