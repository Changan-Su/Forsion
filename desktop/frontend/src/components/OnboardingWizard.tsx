/**
 * 首启引导向导:① 连接(Forsion 账号登录 / 自定义 provider)→ ② 默认模型 → ③ 环境检测(缺失项
 * 给平台安装命令,用户确认后内置日志面板执行——绝不静默自动装)→ ④ 完成(指路导入/设置)。
 * 触发条件见 App.tsx(managed 从未配置:无 cloudUrl/token/provider);「跳过」永久记 localStorage。
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowRight, ArrowLeft, Check, Cloud, KeyRound, Loader2, LogIn, ExternalLink,
  MonitorCheck, Play, SkipForward, Sparkles,
} from 'lucide-react'
import { listModels, testProviderConnection } from '../services/backendService'
import type { EnvProbeResult, ModelsResponse } from '../types'

export const ONBOARDING_DISMISS_KEY = 'forsion_tangu_onboarding_done'

type Step = 'connect' | 'model' | 'env' | 'done'
const STEP_ORDER: Step[] = ['connect', 'model', 'env', 'done']

export const OnboardingWizard: React.FC<{
  /** 向导内动作改变了主配置(登录成功/保存 provider)→ App 重连。 */
  onReconnect: () => void
  onFinish: () => void
}> = ({ onReconnect, onFinish }) => {
  const [step, setStep] = useState<Step>('connect')
  const stepIdx = STEP_ORDER.indexOf(step)

  // ── ① 连接 ──
  const [connectMode, setConnectMode] = useState<'forsion' | 'byok'>('forsion')
  const [cloudUrl, setCloudUrl] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [device, setDevice] = useState<{ url: string; userCode: string } | null>(null)
  const [connectMsg, setConnectMsg] = useState('')
  // byok 表单
  const [pid, setPid] = useState('')
  const [purl, setPurl] = useState('')
  const [pkey, setPkey] = useState('')
  const [pmodels, setPmodels] = useState('')
  const [byokSaved, setByokSaved] = useState(false)
  const [byokTesting, setByokTesting] = useState(false)

  useEffect(() => {
    void window.tangu?.authStatus?.().then((a) => {
      setCloudUrl((u) => u || a.cloudUrl || '')
      setLoggedIn(a.loggedIn)
    })
    const off = window.tangu?.onAuthDevice?.((info) => setDevice(info))
    return () => off?.()
  }, [])

  const doLogin = async (): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    setLoggingIn(true)
    setConnectMsg('')
    setDevice(null)
    try {
      await window.tangu.setConfig({ mode: 'managed', cloudUrl })
      await window.tangu.forsionLogin(cloudUrl)
      setLoggedIn(true)
      setConnectMsg('✓ 登录成功,托管后端启动中…')
      onReconnect()
    } catch (e: any) {
      setConnectMsg(String(e?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setLoggingIn(false)
      setDevice(null)
    }
  }

  const saveByok = async (): Promise<void> => {
    if (!window.tangu?.saveProvider) return
    setByokTesting(true)
    setConnectMsg('')
    try {
      const modelIds = pmodels.split(',').map((s) => s.trim()).filter(Boolean)
      await window.tangu.setConfig({ mode: 'managed' })
      await window.tangu.saveProvider({
        providerId: pid.trim(),
        baseUrl: purl.trim().replace(/\/+$/, ''),
        apiKey: pkey || undefined,
        modelIds: modelIds.length ? modelIds : undefined,
      })
      setByokSaved(true)
      setConnectMsg('✓ Provider 已保存,托管后端启动中…')
      onReconnect()
    } catch (e: any) {
      setConnectMsg(`保存失败:${e?.message || e}`)
    } finally {
      setByokTesting(false)
    }
  }

  // ── ② 默认模型 ──
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [chosenModel, setChosenModel] = useState('')

  const loadStepModels = (): void => {
    setModelsLoading(true)
    void window.tangu?.getConfig().then((c) =>
      listModels({ backendUrl: c.backendUrl, token: c.token, modelId: '' })
        .then((m) => {
          setModels(m)
          setChosenModel((cur) => cur || m.defaultModelId || m.models[0]?.id || '')
        })
        .catch(() => setModels(null))
        .finally(() => setModelsLoading(false)),
    )
  }
  useEffect(() => {
    if (step === 'model') loadStepModels()
    if (step === 'env') void doEnvCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ── ③ 环境检测 ──
  const [probes, setProbes] = useState<EnvProbeResult[] | null>(null)
  const [envChecking, setEnvChecking] = useState(false)
  const [runningInstall, setRunningInstall] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  const doEnvCheck = async (): Promise<void> => {
    if (!window.tangu?.envCheck) return
    setEnvChecking(true)
    try {
      setProbes(await window.tangu.envCheck())
    } finally {
      setEnvChecking(false)
    }
  }

  useEffect(() => {
    const off = window.tangu?.onEnvOutput?.((ev) => {
      setInstallLog((prev) => [...prev.slice(-400), ...ev.line.split('\n').filter(Boolean)])
      requestAnimationFrame(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight))
    })
    return () => off?.()
  }, [])

  const runInstall = async (p: EnvProbeResult): Promise<void> => {
    if (!p.installId || !window.tangu?.envRun) return
    if (!window.confirm(`将在本机执行:\n\n${p.installCommand}\n\n确认继续?(可能需要输入系统密码的命令请改在终端手动执行)`)) return
    setRunningInstall(p.installId)
    setInstallLog([])
    try {
      await window.tangu.envRun(p.installId)
      await doEnvCheck() // 装完重测
    } finally {
      setRunningInstall(null)
    }
  }

  const finish = (): void => {
    try { localStorage.setItem(ONBOARDING_DISMISS_KEY, '1') } catch { /* ignore */ }
    onFinish()
  }

  const connectReady = loggedIn || byokSaved

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="modal modal-md">
        <div className="modal-head">
          <Sparkles size={15} style={{ marginRight: 6 }} />
          欢迎使用 Tangu Agent
          <span className="grow" />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{stepIdx + 1} / {STEP_ORDER.length}</span>
        </div>
        <div className="modal-body">
          {step === 'connect' && (
            <>
              <div className="field">
                <label>第一步:连接模型</label>
                <div className="seg">
                  <button className={connectMode === 'forsion' ? 'active' : ''} onClick={() => setConnectMode('forsion')}>
                    <Cloud size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Forsion 账号
                  </button>
                  <button className={connectMode === 'byok' ? 'active' : ''} onClick={() => setConnectMode('byok')}>
                    <KeyRound size={12} style={{ verticalAlign: -2, marginRight: 4 }} />自定义 Provider
                  </button>
                </div>
              </div>
              {connectMode === 'forsion' ? (
                <>
                  <div className="field">
                    <label>Forsion 云端地址</label>
                    <input type="text" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value.trim())} placeholder="https://api.forsion.app" />
                    <div className="hint">提供托管模型、记忆、云端技能;浏览器登录后凭证与 CLI/TUI 通用。</div>
                  </div>
                  <button className="btn primary sm" disabled={loggingIn || !cloudUrl} onClick={() => void doLogin()}>
                    {loggingIn ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />} 通过浏览器登录
                  </button>
                  {device && (
                    <div className="hint" style={{ marginTop: 6 }}>
                      浏览器没弹出来?手动打开:
                      <a href={device.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                        {device.url} <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                      </a>
                      {device.userCode ? <> · 验证码 <b>{device.userCode}</b></> : null}
                    </div>
                  )}
                  {loggedIn && <div className="hint" style={{ marginTop: 6 }}>✓ 已登录</div>}
                </>
              ) : (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label>Provider ID</label>
                      <input type="text" value={pid} onChange={(e) => setPid(e.target.value.trim())} placeholder="如 ollama / openai" />
                    </div>
                    <div className="field">
                      <label>API Key(本地端点可空)</label>
                      <input type="password" value={pkey} onChange={(e) => setPkey(e.target.value)} placeholder="sk-…" />
                    </div>
                  </div>
                  <div className="field">
                    <label>Base URL(OpenAI 兼容,含 /v1)</label>
                    <input type="text" value={purl} onChange={(e) => setPurl(e.target.value.trim())} placeholder="http://localhost:11434/v1" />
                  </div>
                  <div className="field">
                    <label>模型白名单(逗号分隔,可空)</label>
                    <input type="text" value={pmodels} onChange={(e) => setPmodels(e.target.value)} placeholder="llama3, qwen2.5-coder" />
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn primary sm" disabled={byokTesting || !pid || !purl} onClick={() => void saveByok()}>
                      {byokTesting ? <Loader2 size={12} className="spin" /> : <Check size={12} />} 保存并启动
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={!purl}
                      onClick={() => {
                        void window.tangu?.getConfig().then((c) =>
                          testProviderConnection({ backendUrl: c.backendUrl, token: c.token, modelId: '' }, {
                            baseUrl: purl, apiKey: pkey || undefined,
                            modelId: pmodels.split(',').map((s) => s.trim()).filter(Boolean)[0],
                          }).then((r) => setConnectMsg(`${r.success ? '✓' : '✗'} ${r.message}`))
                            .catch((e) => setConnectMsg(`✗ ${e?.message || e}(后端未就绪时请先保存)`)),
                        )
                      }}
                    >
                      测试连接
                    </button>
                  </div>
                </>
              )}
              {connectMsg && <div className="hint" style={{ marginTop: 8 }}>{connectMsg}</div>}
            </>
          )}

          {step === 'model' && (
            <>
              <div className="field">
                <label>第二步:选择默认模型</label>
                {modelsLoading && <div className="hint">加载中…(托管后端可能还在启动,稍候点刷新)</div>}
                {!modelsLoading && !models?.models.length && (
                  <div className="hint">
                    暂无可用模型 —— 后端可能还在启动。
                    <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={loadStepModels}>刷新</button>
                  </div>
                )}
                {!!models?.models.length && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {models.models.map((m) => (
                      <button key={`${m.source}-${m.id}`} className="file-row" onClick={() => setChosenModel(m.id)}>
                        <span className="file-name" style={{ color: m.id === chosenModel ? 'var(--accent)' : undefined }}>
                          {m.id === chosenModel ? '● ' : ''}{m.name}
                        </span>
                        <span className="file-size">{m.source === 'direct' ? `直连·${m.provider}` : m.provider}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 'env' && (
            <>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <MonitorCheck size={13} /> 第三步:环境检测(缺失项可一键安装,需你确认)
                </label>
                {envChecking && <div className="hint">检测中…</div>}
                {probes?.map((pr) => (
                  <div key={pr.tool} className="file-row" style={{ cursor: 'default' }}>
                    <span className="file-name">
                      {pr.found ? '✅' : '⚠️'} <b>{pr.tool}</b>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                        {pr.found ? pr.version : pr.tool === 'docker' ? '未检测到(代码沙箱将禁用,可选)' : pr.tool === 'npm' ? '未检测到(随 node 安装)' : '未检测到'}
                      </span>
                    </span>
                    {!pr.found && pr.installId && (
                      <button
                        className="btn ghost sm"
                        disabled={runningInstall !== null}
                        title={pr.installCommand || ''}
                        onClick={() => void runInstall(pr)}
                      >
                        {runningInstall === pr.installId ? <Loader2 size={12} className="spin" /> : <Play size={12} />} 安装
                      </button>
                    )}
                  </div>
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
                <div className="hint" style={{ marginTop: 6 }}>
                  node/git 用于本机编码任务;docker 供 Python 代码沙箱(可选);带 sudo 的命令建议在终端手动执行。
                </div>
              </div>
            </>
          )}

          {step === 'done' && (
            <div className="field">
              <label>完成 🎉</label>
              <div className="panel-note" style={{ lineHeight: 1.8 }}>
                · 输入栏可随时切换模型与思考深度;选择「本机」执行真实文件操作(带审批)<br />
                · 已有 Claude Code / Codex / Hermes?设置 → 高级 → 「从其他 Agent 导入」一键迁移技能与 MCP<br />
                · 设置 → Provider / MCP 可随时添加更多模型与工具
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            {stepIdx > 0 && step !== 'done' && (
              <button className="btn ghost sm" onClick={() => setStep(STEP_ORDER[stepIdx - 1])}>
                <ArrowLeft size={12} /> 上一步
              </button>
            )}
            <span className="grow" />
            <button className="btn ghost sm" onClick={finish}>
              <SkipForward size={12} /> 跳过引导
            </button>
            {step !== 'done' ? (
              <button
                className="btn primary sm"
                disabled={step === 'connect' && !connectReady}
                onClick={() => {
                  if (step === 'model' && chosenModel) {
                    void window.tangu?.setConfig({ modelId: chosenModel })
                  }
                  setStep(STEP_ORDER[stepIdx + 1])
                }}
              >
                下一步 <ArrowRight size={12} />
              </button>
            ) : (
              <button className="btn primary sm" onClick={finish}>
                开始使用 <Check size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
