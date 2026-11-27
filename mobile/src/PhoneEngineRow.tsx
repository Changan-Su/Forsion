/**
 * 「在哪运行」里的「这台手机」一行(本机引擎第 1 期,排在 Forsion 云端下面、电脑上面)。
 *
 * 只在安卓 App 带了启动器、且构建配了环境包地址时出现(phoneEngineOffered)。一行走完整个生命周期:
 *   没装 → 点开确认(下载 / 占用大小、用流量时提醒、没有命令沙箱的说明)→ 下载(可暂停 / 继续,断点续传)→ 解包 → 自检
 *   → 装好:点一下 = 选它运行(setDraftLocation,与电脑同一个出口);右侧「⌄」展开详情:占用、版本、更新、停止、重置、删除。
 * 对话与工作区文件在环境之外(原生 files/local-engine/home、workspace):更新 / 重置 / 删除环境都不动它们。
 *
 * ⚠️ 本组件挂在 UnitsSheet 里,而 UnitsSheet 也被网页手机形态复用:不许 import capacitor,原生能力只经
 *    window.tangu.localEngine(phoneEngineHost();网页 / 老包缺席 → 本行不渲染)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, Smartphone } from 'lucide-react'
import { registerMessages, useI18n } from '@/i18n'
import { mb, phoneEngineHost, phoneEngineName, phoneEngineOffered, usePhoneEngine, type PhoneEngineState, type PhoneEngineUsage } from '@/services/engine/phoneEngine'

registerMessages({
  'phoneEngine.needDownload': { zh: '需要先下载运行环境（约 {size} MB）', en: 'Download the environment first (about {size} MB)' },
  'phoneEngine.needDownloadNoSize': { zh: '需要先下载运行环境', en: 'Download the environment first' },
  'phoneEngine.confirmTitle': { zh: '在这台手机上运行 Agent？', en: 'Run the agent on this phone?' },
  'phoneEngine.confirmSize': { zh: '要下载约 {download} MB，装好后占用约 {disk} MB。', en: 'Downloads about {download} MB and uses about {disk} MB once installed.' },
  'phoneEngine.confirmModel': { zh: '模型仍经 Forsion 云端调用；命令和文件操作在这台手机上的独立环境里执行。', en: 'Models are still called through Forsion cloud. Commands and file changes happen in a separate environment on this phone.' },
  'phoneEngine.confirmSandbox': { zh: '这个环境没有命令沙箱：Agent 能读写环境里的所有文件，但碰不到手机上的其他 App 和照片。', en: "This environment has no command sandbox. The agent can read and change any file in it, but can't reach other apps or your photos." },
  'phoneEngine.metered': { zh: '现在用的是移动数据，下载会消耗流量。', en: "You're on mobile data. The download uses your data plan." },
  'phoneEngine.cancel': { zh: '取消', en: 'Cancel' },
  'phoneEngine.confirmLoading': { zh: '正在查询下载大小…', en: 'Checking the download size…' },
  'phoneEngine.download': { zh: '下载', en: 'Download' },
  'phoneEngine.downloading': { zh: '正在下载 {done} / {total} MB', en: 'Downloading {done} / {total} MB' },
  'phoneEngine.paused': { zh: '已暂停 · {done} / {total} MB', en: 'Paused · {done} / {total} MB' },
  'phoneEngine.unpacking': { zh: '正在解包…', en: 'Unpacking…' },
  'phoneEngine.checking': { zh: '正在检查环境…', en: 'Checking the environment…' },
  'phoneEngine.pause': { zh: '暂停', en: 'Pause' },
  'phoneEngine.resume': { zh: '继续', en: 'Resume' },
  'phoneEngine.retry': { zh: '重试', en: 'Retry' },
  'phoneEngine.ready': { zh: '已就绪', en: 'Ready' },
  'phoneEngine.running': { zh: '运行中', en: 'Running' },
  'phoneEngine.starting': { zh: '正在启动…', en: 'Starting…' },
  'phoneEngine.updateAvailable': { zh: '可更新', en: 'Update' },
  'phoneEngine.details': { zh: '本机环境详情', en: 'Local environment details' },
  'phoneEngine.usage': { zh: '环境占用 {env} MB · 对话与文件 {data} MB', en: 'Environment {env} MB · chats and files {data} MB' },
  'phoneEngine.usageLoading': { zh: '正在计算占用…', en: 'Calculating storage…' },
  'phoneEngine.version': { zh: '引擎 {engine} · 系统 {base}', en: 'Engine {engine} · system {base}' },
  'phoneEngine.update': { zh: '更新（约 {size} MB）', en: 'Update (about {size} MB)' },
  'phoneEngine.stop': { zh: '停止', en: 'Stop' },
  'phoneEngine.reset': { zh: '重置环境', en: 'Reset environment' },
  'phoneEngine.remove': { zh: '删除环境', en: 'Delete environment' },
  'phoneEngine.resetConfirm': { zh: '重新下载并替换运行环境（约 {size} MB）。对话和工作区文件会保留。', en: 'Downloads the environment again (about {size} MB) and replaces it. Chats and workspace files are kept.' },
  'phoneEngine.removeConfirm': { zh: '删除运行环境，释放约 {size} MB。对话和工作区文件会保留，下次使用要重新下载。', en: 'Deletes the environment and frees about {size} MB. Chats and workspace files are kept; you will need to download it again to use it.' },
  // 原生 LocalEngineInstaller.Failure 的码
  'phoneEngine.err.manifest': { zh: '读不到环境清单，请稍后重试', en: "Couldn't read the environment list. Try again later" },
  'phoneEngine.err.network': { zh: '下载中断，请检查网络后重试', en: 'The download stopped. Check your connection and retry' },
  'phoneEngine.err.checksum': { zh: '下载的文件没通过校验，已删掉，请重试', en: "The download didn't pass verification and was deleted. Try again" },
  'phoneEngine.err.unpack': { zh: '解包失败，请重试', en: "Couldn't unpack the environment. Try again" },
  'phoneEngine.err.space': { zh: '手机剩余存储不够', en: 'Not enough storage on this phone' },
  'phoneEngine.err.selftest': { zh: '环境装好了，但自检没通过', en: 'The environment installed but failed its self-check' },
  'phoneEngine.err.notConfigured': { zh: '这个版本没有配置环境下载地址', en: "This build doesn't have an environment download address" },
  'phoneEngine.err.unsupported': { zh: '这台手机不支持（需要 64 位 ARM）', en: 'This phone is not supported (needs 64-bit ARM)' },
  'phoneEngine.err.other': { zh: '没能装好，请重试', en: "Couldn't install. Try again" },
})

const ERR_KEY: Record<string, string> = {
  manifest: 'phoneEngine.err.manifest',
  download: 'phoneEngine.err.network',
  network: 'phoneEngine.err.network',
  checksum: 'phoneEngine.err.checksum',
  unpack: 'phoneEngine.err.unpack',
  space: 'phoneEngine.err.space',
  selftest: 'phoneEngine.err.selftest',
  not_configured: 'phoneEngine.err.notConfigured',
  unsupported: 'phoneEngine.err.unsupported',
}

type Panel = null | 'confirm' | 'details' | 'reset' | 'remove'

const busyPhase = (s: PhoneEngineState | null): boolean => ['downloading', 'paused', 'unpacking', 'checking'].includes(s?.phase || '')

export function PhoneEngineRow({ selected, onPick }: { selected: boolean; onPick(): void }): React.ReactElement | null {
  const { t } = useI18n()
  const st = usePhoneEngine((s) => s.state)
  const [panel, setPanel] = useState<Panel>(null)
  // 确认框里的两项披露(要下多少、是不是在用流量)都到齐之前「下载」点不了;清单读失败 → 可重试的错误
  const [chk, setChk] = useState<'loading' | 'ok' | 'error'>('loading')
  const [metered, setMetered] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<PhoneEngineUsage | null>(null)
  const host = phoneEngineHost()
  // 每次打开确认框一代:上一次打开时没回来的结果(大小、流量)不许落到这一次上
  const confirmGen = useRef(0)
  const runCheck = useCallback(() => {
    if (!host) return
    const gen = confirmGen.current
    setChk('loading')
    void host.check().then(() => { if (confirmGen.current === gen) setChk('ok') }, () => { if (confirmGen.current === gen) setChk('error') })
  }, [host])

  // 弹层一打开、还没装:先查一次清单,行上就能写出要下多少(只查一次,不随每次渲染)
  const offered = phoneEngineOffered(st)
  const needSize = offered && !st?.installed && !st?.downloadBytes && !busyPhase(st)
  useEffect(() => {
    if (host && needSize) void host.check().catch(() => {})
  }, [host, needSize])

  // 展开确认:现查一次清单(大小)与是否在用流量;展开详情:现算占用
  useEffect(() => {
    if (!host) return
    if (panel === 'confirm') {
      const gen = ++confirmGen.current
      runCheck()
      setMetered(null)
      // 判不出来就按在用流量提醒(宁可多提醒一句)
      void host.metered().then((m) => { if (confirmGen.current === gen) setMetered(!!m?.metered) }, () => { if (confirmGen.current === gen) setMetered(true) })
    } else {
      confirmGen.current++
      setChk('loading')
      setMetered(null)
    }
    if (panel === 'details') {
      void host.check().catch(() => {}) // 有没有新版本
      setUsage(null)
      void host.usage().then(setUsage, () => setUsage(null))
    }
  }, [panel, host, runCheck])

  if (!host || !offered) return null
  const s = st as PhoneEngineState
  const installed = !!s.installed
  const working = busyPhase(s)
  const failedInstall = s.phase === 'failed' && !!s.error
  const name = phoneEngineName()
  const call = (p: Promise<unknown>): void => { void p.catch(() => { /* 失败落在原生状态里(phase failed + error),行上照着显示 */ }) }

  let sub: React.ReactNode
  let tone = ''
  if (s.phase === 'downloading') sub = t('phoneEngine.downloading', { done: mb(s.done), total: mb(s.total) })
  else if (s.phase === 'paused') sub = t('phoneEngine.paused', { done: mb(s.done), total: mb(s.total) })
  else if (s.phase === 'unpacking') sub = t('phoneEngine.unpacking')
  else if (s.phase === 'checking') sub = t('phoneEngine.checking')
  else if (failedInstall) { sub = t(ERR_KEY[s.error || ''] || 'phoneEngine.err.other'); tone = 'warn' }
  else if (!installed) sub = s.downloadBytes ? t('phoneEngine.needDownload', { size: mb(s.downloadBytes) }) : t('phoneEngine.needDownloadNoSize')
  else if (s.engine === 'running') { sub = t('phoneEngine.running'); tone = 'ok' }
  else if (s.engine === 'starting') { sub = t('phoneEngine.starting'); tone = 'wait' }
  else if (s.engine === 'failed') { sub = t('phoneEngine.startFailed'); tone = 'warn' }
  else sub = t('phoneEngine.ready')

  const onRow = (): void => {
    if (working) return
    if (!installed) { setPanel(panel === 'confirm' ? null : 'confirm'); return }
    setPanel(null)
    onPick()
  }
  const progress = s.phase === 'downloading' || s.phase === 'paused' ? (s.total ? Math.min(1, (s.done || 0) / s.total) : 0) : null

  return (
    <div className="us-phone" data-phone-engine data-phase={s.phase || 'idle'} data-installed={installed || undefined} data-engine={s.engine || 'stopped'}>
      <div className="us-phone-line">
        <button className="mb-sheet-row us-row" data-run-row="phone" aria-pressed={selected} aria-busy={working || s.engine === 'starting' || undefined} onClick={onRow}>
          <span className="us-row-icon"><Smartphone size={18} /></span>
          <span className="us-row-main">
            <span className="us-row-title">
              <span className="us-row-name">{name}</span>
              {installed && s.updateAvailable && <em className="us-pill muted">{t('phoneEngine.updateAvailable')}</em>}
            </span>
            <span className="us-row-sub" role="status">
              {tone && <i className={`settings-status-dot ${tone}`} aria-hidden />}
              <span>{sub}</span>
            </span>
          </span>
          <span className="us-row-end">
            {selected ? <><em className="us-pill">{t('unitm.current')}</em><Check size={16} /></> : !working && !installed ? <ArrowRight size={15} /> : null}
          </span>
        </button>
        {working && s.phase !== 'unpacking' && s.phase !== 'checking' && (
          <button className="us-btn us-phone-act" onClick={() => call(s.phase !== 'paused' ? host.pause() : host.resume())}>
            {t(s.phase === 'paused' ? 'phoneEngine.resume' : 'phoneEngine.pause')}
          </button>
        )}
        {!working && failedInstall && (
          <button className="us-btn us-phone-act" onClick={() => call(host.resume())}>{t('phoneEngine.retry')}</button>
        )}
        {installed && !working && (
          <button className="us-icon-btn us-phone-more" aria-label={t('phoneEngine.details')} aria-expanded={panel === 'details' || panel === 'reset' || panel === 'remove'} onClick={() => setPanel(panel ? null : 'details')}>
            <ChevronDown size={16} />
          </button>
        )}
      </div>
      {progress !== null && <div className="us-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${progress * 100}%` }} /></div>}

      {panel === 'confirm' && !installed && !working && (
        <div className="us-panel" data-phone-confirm>
          <div className="us-panel-title">{t('phoneEngine.confirmTitle')}</div>
          {chk === 'ok' && !!s.downloadBytes && <div>{t('phoneEngine.confirmSize', { download: mb(s.downloadBytes), disk: mb(s.unpackedBytes) })}</div>}
          {chk === 'loading' && <div className="us-panel-muted" role="status">{t('phoneEngine.confirmLoading')}</div>}
          {chk === 'error' && (
            <div className="us-panel-warn" role="status">
              {t('phoneEngine.err.manifest')} <button className="us-link" onClick={runCheck}>{t('phoneEngine.retry')}</button>
            </div>
          )}
          <div>{t('phoneEngine.confirmModel')}</div>
          <div>{t('phoneEngine.confirmSandbox')}</div>
          {metered && <div className="us-panel-warn" role="status">{t('phoneEngine.metered')}</div>}
          <div className="us-confirm-actions">
            <button className="us-btn" onClick={() => setPanel(null)}>{t('phoneEngine.cancel')}</button>
            <button className="us-btn primary" data-phone-download disabled={chk !== 'ok' || !s.downloadBytes || metered === null} onClick={() => { setPanel(null); call(host.install()) }}>{t('phoneEngine.download')}</button>
          </div>
        </div>
      )}

      {panel === 'details' && installed && (
        <div className="us-panel" data-phone-details>
          <div>{usage ? t('phoneEngine.usage', { env: mb(usage.environment), data: mb((usage.home || 0) + (usage.workspace || 0)) }) : t('phoneEngine.usageLoading')}</div>
          <div>{t('phoneEngine.version', { engine: s.engineVersion || '?', base: s.baseVersion || '?' })}</div>
          <div className="us-panel-actions">
            {s.updateAvailable && <button className="us-btn" onClick={() => { setPanel(null); call(host.update()) }}>{t('phoneEngine.update', { size: mb(s.engineDownloadBytes) })}</button>}
            {(s.engine === 'running' || s.engine === 'starting') && <button className="us-btn" onClick={() => call(host.stop())}>{t('phoneEngine.stop')}</button>}
            <button className="us-btn" onClick={() => setPanel('reset')}>{t('phoneEngine.reset')}</button>
            <button className="us-btn danger" onClick={() => setPanel('remove')}>{t('phoneEngine.remove')}</button>
          </div>
        </div>
      )}
      {panel === 'reset' && (
        <div className="us-panel" data-phone-reset>
          <div>{t('phoneEngine.resetConfirm', { size: mb(s.downloadBytes) })}</div>
          <div className="us-confirm-actions">
            <button className="us-btn" onClick={() => setPanel('details')}>{t('phoneEngine.cancel')}</button>
            <button className="us-btn primary" onClick={() => { setPanel(null); call(host.install({ reset: true })) }}>{t('phoneEngine.reset')}</button>
          </div>
        </div>
      )}
      {panel === 'remove' && (
        <div className="us-confirm" data-phone-remove>
          <div>{t('phoneEngine.removeConfirm', { size: mb(usage?.environment || s.unpackedBytes) })}</div>
          <div className="us-confirm-actions">
            <button className="us-btn" onClick={() => setPanel('details')}>{t('phoneEngine.cancel')}</button>
            <button className="us-btn danger" onClick={() => { setPanel(null); call(host.remove()) }}>{t('phoneEngine.remove')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
