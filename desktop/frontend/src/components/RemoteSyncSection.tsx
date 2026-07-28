/**
 * 设置 → 同步:「本地库远程同步」节(remotely-save 式;Forsion 云端/Dropbox/S3/WebDAV/文件夹)。
 * 自包含(自取 useI18n + window.remoteSync),web/mobile 下 API 缺位自动隐藏。
 * 分组照 remotely-save:远程服务(含测试连接/Dropbox PKCE 连接流)/ 同步计划(间隔+方式+启动同步)/
 * 高级(忽略+单文件上限+并发)/ 操作与最近结果(含预演 dry run);
 * 同步进行中展示主进程广播的进度(执行阶段 x/y,对账阶段不定态)。
 */
import React, { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useI18n } from '../i18n'
import type { RemoteSyncConfig, RemoteSyncProgress, RemoteSyncReport, RemoteSyncState } from '../types'

export function RemoteSyncSection(): React.ReactElement | null {
  const { t } = useI18n()
  const api = window.remoteSync
  const [cfg, setCfg] = useState<RemoteSyncConfig | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RemoteSyncProgress | null>(null)
  const [report, setReport] = useState<RemoteSyncReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [svcNote, setSvcNote] = useState<string | null>(null)
  const [dbxCode, setDbxCode] = useState('')
  const [dbxManual, setDbxManual] = useState(false) // 回环端口起不来时才露出手贴授权码
  const [dbxWaiting, setDbxWaiting] = useState(false)
  const [dbxBuiltin, setDbxBuiltin] = useState(false) // 有官方应用 = 不用填 App Key
  const [dbxOwnApp, setDbxOwnApp] = useState(false) // 用户主动要用自建应用

  /** 只吃回授权得来的凭据,不覆盖用户此刻未保存的 appKey/baseDir 输入。 */
  const applyDbxCreds = (d?: RemoteSyncConfig['dropbox']): void =>
    setCfg((c) =>
      c ? { ...c, dropbox: { ...(c.dropbox ?? { appKey: '' }), refreshToken: d?.refreshToken, accountId: d?.accountId, email: d?.email } } : c,
    )

  useEffect(() => {
    if (!api) return
    void api.get().then((s: RemoteSyncState) => {
      setCfg(s.config)
      setRoot(s.root)
      setRootError(s.rootError)
      setRunning(s.running)
      setProgress(s.progress ?? null)
      setReport(s.lastReport)
      setDbxBuiltin(!!s.dropboxBuiltin)
    })
    const offStatus = api.onStatus((s) => {
      setRunning(s.running)
      setProgress(s.progress ?? null)
      if (s.lastReport) setReport(s.lastReport)
    })
    // 链接登录:浏览器授权完成后主进程回推结果
    const offDbx = api.onDropboxAuth((r) => {
      setDbxWaiting(false)
      if (!r.ok) {
        setSvcNote(r.error || 'error')
        return
      }
      applyDbxCreds(r.config?.dropbox)
      setSvcNote(t('settings.remotesync.dbxConnected', { who: r.email || 'Dropbox' }))
    })
    return () => {
      offStatus()
      offDbx()
    }
  }, [api, t])

  if (!api || !cfg) return null
  const patch = (p: Partial<RemoteSyncConfig>): void => {
    setCfg({ ...cfg, ...p })
    setNote(null)
    setSvcNote(null)
  }
  const save = (): void => {
    setBusy(true)
    void api
      .set(cfg)
      .then((c) => {
        setCfg(c)
        setNote(t('settings.remotesync.saved'))
      })
      .finally(() => setBusy(false))
  }
  const runSync = (allowMassDelete?: boolean): void => {
    setBusy(true)
    setNote(null)
    void api
      .run(allowMassDelete ? { allowMassDelete: true } : undefined)
      .then(setReport)
      .finally(() => setBusy(false))
  }
  const dryRun = (): void => {
    setBusy(true)
    setNote(null)
    void api
      .run({ dryRun: true })
      .then((r) => {
        if (r.plan) {
          const c = { push: 0, pull: 0, del: 0, conf: 0 }
          for (const p of r.plan) {
            if (p.kind === 'push') c.push++
            else if (p.kind === 'pull') c.pull++
            else if (p.kind === 'pushDelete' || p.kind === 'deleteLocal') c.del++
            else c.conf++
          }
          setNote(t('settings.remotesync.dryResult', { push: String(c.push), pull: String(c.pull), del: String(c.del), conf: String(c.conf) }))
        } else setNote(r.errors?.[0] || 'error')
      })
      .finally(() => setBusy(false))
  }
  const testConn = (): void => {
    setBusy(true)
    void api
      .check()
      .then((r) => setSvcNote(r.ok ? t('settings.remotesync.testOk') : r.error || 'error'))
      .finally(() => setBusy(false))
  }
  const dbxStart = (): void => {
    const key = (cfg.dropbox?.appKey ?? '').trim()
    if (!key && !dbxBuiltin) {
      setSvcNote(t('settings.remotesync.dbxNeedKey'))
      return
    }
    setBusy(true)
    void api
      .dropboxAuthStart(key)
      .then((r) => {
        if (!r.ok) {
          setSvcNote(r.error || 'error')
          return
        }
        const manual = r.mode !== 'auto'
        setDbxManual(manual)
        setDbxWaiting(!manual)
        setSvcNote(manual ? t('settings.remotesync.dbxOpened') : t('settings.remotesync.dbxOpenedAuto'))
      })
      .finally(() => setBusy(false))
  }
  const dbxFinish = (): void => {
    const key = (cfg.dropbox?.appKey ?? '').trim()
    setBusy(true)
    void api
      .dropboxAuthFinish(key, dbxCode.trim())
      .then((r) => {
        if (r.ok) {
          applyDbxCreds(r.config?.dropbox)
          setDbxManual(false)
          setDbxCode('')
          setSvcNote(t('settings.remotesync.dbxConnected', { who: r.email || 'Dropbox' }))
        } else setSvcNote(r.error || 'error')
      })
      .finally(() => setBusy(false))
  }

  const on = cfg.backend !== 'off'
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <>
      {/* ── 远程服务(remotely-save: Choose remote service + Check Connectivity)── */}
      <div className="field">
        <label>{t('settings.remotesync.service')}</label>
        <div className="hint">{t('settings.remotesync.hint')}</div>
        {root && <div className="hint">{t('settings.remotesync.scope', { root })}</div>}
        <div style={{ marginTop: 6 }}>
          <select value={cfg.backend} onChange={(e) => patch({ backend: e.target.value as RemoteSyncConfig['backend'] })}>
            <option value="off">{t('settings.remotesync.backendOff')}</option>
            <option value="penzor">{t('settings.remotesync.backendPenzor')}</option>
            <option value="dropbox">Dropbox</option>
            <option value="folder">{t('settings.remotesync.backendFolder')}</option>
            <option value="s3">{t('settings.remotesync.backendS3')}</option>
            <option value="webdav">{t('settings.remotesync.backendWebdav')}</option>
          </select>
        </div>

        {cfg.backend === 'penzor' && (
          <div style={{ marginTop: 6 }}>
            <input
              type="text"
              value={cfg.penzor?.vault ?? ''}
              placeholder={t('settings.remotesync.penzorVault')}
              onChange={(e) => patch({ penzor: { vault: e.target.value } })}
            />
            <div className="hint">{t('settings.remotesync.penzorHint')}</div>
          </div>
        )}

        {cfg.backend === 'dropbox' && (
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            {/* 有官方应用就别拿 App Key 拦人:只有自建应用才露这一栏 */}
            {(!dbxBuiltin || dbxOwnApp || (cfg.dropbox?.appKey ?? '') !== '') && (
              <input
                type="text"
                value={cfg.dropbox?.appKey ?? ''}
                placeholder={t('settings.remotesync.dbxAppKey')}
                onChange={(e) => patch({ dropbox: { ...(cfg.dropbox ?? {}), appKey: e.target.value } })}
              />
            )}
            <input
              type="text"
              value={cfg.dropbox?.baseDir ?? ''}
              placeholder={t('settings.remotesync.dbxBaseDir')}
              onChange={(e) => patch({ dropbox: { ...(cfg.dropbox ?? { appKey: '' }), appKey: cfg.dropbox?.appKey ?? '', baseDir: e.target.value } })}
            />
            <div className="settings-inline-row">
              <button className="btn ghost sm" disabled={busy || dbxWaiting} onClick={dbxStart}>
                {cfg.dropbox?.refreshToken ? t('settings.remotesync.dbxReconnect') : t('settings.remotesync.dbxConnect')}
              </button>
              {dbxWaiting && <span className="hint">{t('settings.remotesync.dbxWaiting')}</span>}
              {cfg.dropbox?.refreshToken && !dbxManual && !dbxWaiting && (
                <span className="hint">{t('settings.remotesync.dbxConnected', { who: cfg.dropbox.email || cfg.dropbox.accountId || 'Dropbox' })}</span>
              )}
            </div>
            {dbxManual && (
              <div className="settings-inline-row">
                <input
                  type="text"
                  value={dbxCode}
                  placeholder={t('settings.remotesync.dbxCodePlaceholder')}
                  onChange={(e) => setDbxCode(e.target.value)}
                />
                <button className="btn primary sm" disabled={busy || !dbxCode.trim()} onClick={dbxFinish}>
                  {t('settings.remotesync.dbxFinish')}
                </button>
              </div>
            )}
            <div className="hint">{t(dbxBuiltin && !dbxOwnApp ? 'settings.remotesync.dbxHintBuiltin' : 'settings.remotesync.dbxHint')}</div>
            {dbxBuiltin && !dbxOwnApp && (cfg.dropbox?.appKey ?? '') === '' && (
              <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setDbxOwnApp(true)}>
                {t('settings.remotesync.dbxUseOwnApp')}
              </button>
            )}
          </div>
        )}

        {cfg.backend === 'folder' && (
          <div className="settings-inline-row" style={{ marginTop: 6 }}>
            <input
              type="text"
              value={cfg.folder?.path ?? ''}
              placeholder={t('settings.remotesync.folderPath')}
              onChange={(e) => patch({ folder: { path: e.target.value } })}
            />
            {window.tangu?.pickDirectory && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  const pick = window.tangu?.pickDirectory
                  if (!pick) return
                  void pick().then((p: string | null) => {
                    if (p) patch({ folder: { path: p } })
                  })
                }}
              >
                {t('settings.remotesync.pick')}
              </button>
            )}
          </div>
        )}

        {cfg.backend === 's3' && (
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            <input type="text" value={cfg.s3?.endpoint ?? ''} placeholder="Endpoint (oss-cn-hangzhou.aliyuncs.com)" onChange={(e) => patch({ s3: { ...(cfg.s3 ?? { region: '', accessKeyID: '', secretAccessKey: '', bucket: '', endpoint: '' }), endpoint: e.target.value } })} />
            <div className="settings-inline-row">
              <input type="text" value={cfg.s3?.region ?? ''} placeholder="Region" onChange={(e) => patch({ s3: { ...(cfg.s3 ?? { region: '', accessKeyID: '', secretAccessKey: '', bucket: '', endpoint: '' }), region: e.target.value } })} />
              <input type="text" value={cfg.s3?.bucket ?? ''} placeholder="Bucket" onChange={(e) => patch({ s3: { ...(cfg.s3 ?? { region: '', accessKeyID: '', secretAccessKey: '', bucket: '', endpoint: '' }), bucket: e.target.value } })} />
            </div>
            <input type="text" value={cfg.s3?.accessKeyID ?? ''} placeholder="AccessKey ID" onChange={(e) => patch({ s3: { ...(cfg.s3 ?? { region: '', accessKeyID: '', secretAccessKey: '', bucket: '', endpoint: '' }), accessKeyID: e.target.value } })} />
            <input type="password" value={cfg.s3?.secretAccessKey ?? ''} placeholder="Secret AccessKey" onChange={(e) => patch({ s3: { ...(cfg.s3 ?? { region: '', accessKeyID: '', secretAccessKey: '', bucket: '', endpoint: '' }), secretAccessKey: e.target.value } })} />
            <input type="text" value={cfg.s3?.prefix ?? ''} placeholder={t('settings.remotesync.s3Prefix')} onChange={(e) => patch({ s3: { ...(cfg.s3 ?? { region: '', accessKeyID: '', secretAccessKey: '', bucket: '', endpoint: '' }), prefix: e.target.value } })} />
          </div>
        )}

        {cfg.backend === 'webdav' && (
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            <input type="text" value={cfg.webdav?.address ?? ''} placeholder="https://dav.jianguoyun.com/dav/" onChange={(e) => patch({ webdav: { ...(cfg.webdav ?? { address: '', username: '', password: '' }), address: e.target.value } })} />
            <div className="settings-inline-row">
              <input type="text" value={cfg.webdav?.username ?? ''} placeholder={t('settings.remotesync.wdUser')} onChange={(e) => patch({ webdav: { ...(cfg.webdav ?? { address: '', username: '', password: '' }), username: e.target.value } })} />
              <input type="password" value={cfg.webdav?.password ?? ''} placeholder={t('settings.remotesync.wdPassword')} onChange={(e) => patch({ webdav: { ...(cfg.webdav ?? { address: '', username: '', password: '' }), password: e.target.value } })} />
            </div>
            <input type="text" value={cfg.webdav?.baseDir ?? ''} placeholder={t('settings.remotesync.wdBaseDir')} onChange={(e) => patch({ webdav: { ...(cfg.webdav ?? { address: '', username: '', password: '' }), baseDir: e.target.value } })} />
          </div>
        )}

        {on && (
          <div className="settings-inline-row" style={{ marginTop: 6 }}>
            <button className="btn ghost sm" disabled={busy} onClick={testConn}>
              {t('settings.remotesync.test')}
            </button>
            {svcNote && <span className="hint">{svcNote}</span>}
          </div>
        )}
      </div>

      {/* ── 同步计划(remotely-save: Sync schedule + Sync direction)── */}
      {on && (
        <div className="field">
          <label>{t('settings.remotesync.schedule')}</label>
          <div className="settings-inline-row">
            <select value={String(cfg.intervalMin ?? 0)} onChange={(e) => patch({ intervalMin: Number(e.target.value) })}>
              <option value="0">{t('settings.remotesync.manualOnly')}</option>
              <option value="5">{t('settings.remotesync.everyMin', { n: '5' })}</option>
              <option value="10">{t('settings.remotesync.everyMin', { n: '10' })}</option>
              <option value="30">{t('settings.remotesync.everyMin', { n: '30' })}</option>
              <option value="60">{t('settings.remotesync.everyMin', { n: '60' })}</option>
            </select>
            <select value={cfg.direction ?? 'both'} onChange={(e) => patch({ direction: e.target.value as RemoteSyncConfig['direction'] })}>
              <option value="both">{t('settings.remotesync.dirBoth')}</option>
              <option value="push">{t('settings.remotesync.dirPush')}</option>
              <option value="pull">{t('settings.remotesync.dirPull')}</option>
            </select>
          </div>
          <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={!!cfg.syncOnStart} onChange={(e) => patch({ syncOnStart: e.target.checked })} />
            {t('settings.remotesync.syncOnStart')}
          </label>
          <div className="hint">{t('settings.remotesync.scheduleHint')}</div>
        </div>
      )}

      {/* ── 高级(忽略规则 / 单文件上限 / 并发)── */}
      {on && (
        <div className="field">
          <label>{t('settings.remotesync.advanced')}</label>
          <textarea
            rows={2}
            value={(cfg.ignore ?? []).join('\n')}
            placeholder={t('settings.remotesync.ignoreHint')}
            onChange={(e) => patch({ ignore: e.target.value.split('\n').filter((l) => l.trim() !== '') })}
          />
          <div className="settings-inline-row" style={{ marginTop: 6 }}>
            <input
              type="number"
              min={0}
              style={{ width: 90 }}
              value={cfg.maxFileMB ?? 100}
              onChange={(e) => patch({ maxFileMB: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span className="hint">{t('settings.remotesync.maxFile')}</span>
          </div>
          <div className="settings-inline-row" style={{ marginTop: 6 }}>
            <input
              type="number"
              min={1}
              max={16}
              style={{ width: 90 }}
              value={cfg.concurrency ?? 4}
              onChange={(e) => patch({ concurrency: Math.min(16, Math.max(1, Number(e.target.value) || 4)) })}
            />
            <span className="hint">{t('settings.remotesync.concurrency')}</span>
          </div>
        </div>
      )}

      {/* ── 操作 + 进度 + 最近结果 ── */}
      <div className="field">
        <div className="settings-inline-row">
          <button className="btn primary sm" disabled={busy} onClick={save}>
            {t('settings.btn.save')}
          </button>
          {on && (
            <>
              <button className="btn ghost sm" disabled={busy || running} onClick={dryRun}>
                {t('settings.remotesync.dryRun')}
              </button>
              <button className="btn sm" disabled={busy || running} onClick={() => runSync()}>
                {running ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{' '}
                {running ? t('settings.remotesync.syncing') : t('settings.remotesync.syncNow')}
              </button>
            </>
          )}
          {note && <span className="hint">{note}</span>}
        </div>

        {running && (
          <div className="rsync-progress">
            <div className="rsync-progress-track">
              <div
                className={progress?.total ? 'rsync-progress-fill' : 'rsync-progress-fill indet'}
                style={progress?.total ? { width: `${pct}%` } : undefined}
              />
            </div>
            <span className="hint">
              {progress?.total
                ? `${progress.done}/${progress.total}${progress.key ? ' · ' + progress.key : ''}`
                : t('settings.remotesync.preparing')}
            </span>
          </div>
        )}

        {rootError && <div className="hint" style={{ color: 'var(--danger, #c00)' }}>{t(`settings.remotesync.rootErr.${rootError}`)}</div>}
        {report && !running && (
          <div className="hint">
            {t('settings.remotesync.lastResult', {
              time: new Date(report.finishedAt).toLocaleString(),
              push: String(report.pushed),
              pull: String(report.pulled),
              del: String(report.deletedLocal + report.deletedRemote),
              conf: String(report.conflicts),
            })}
          </div>
        )}
        {report && report.pendingDeletions > 0 && (
          <div className="hint" style={{ color: 'var(--danger, #c00)' }}>
            {t('settings.remotesync.pendingDel', { n: String(report.pendingDeletions) })}{' '}
            <button className="btn sm" disabled={busy || running} onClick={() => runSync(true)}>
              {t('settings.remotesync.confirmDel')}
            </button>
          </div>
        )}
        {report && report.errors.length > 0 && (
          <div className="hint" style={{ color: 'var(--danger, #c00)' }}>
            {t('settings.remotesync.errors')}: {report.errors.slice(0, 3).join('; ')}
            {report.errors.length > 3 ? '…' : ''}
          </div>
        )}
      </div>
    </>
  )
}
