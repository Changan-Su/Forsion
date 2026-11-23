import { useRef, useState } from 'react'
import { registerMessages, useI18n } from '../i18n'
import { request } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'

registerMessages({
  'githubSkill.open': { zh: '从 GitHub 导入', en: 'Import from GitHub' },
  'githubSkill.url': { zh: '含 SKILL.md 的公开 GitHub 目录', en: 'Public GitHub folder containing SKILL.md' },
  'githubSkill.preview': { zh: '预览文件', en: 'Preview files' },
  'githubSkill.install': { zh: '安装到我的技能库', en: 'Install to my skills' },
  'githubSkill.files': { zh: '随包文件（{n}）', en: 'Package files ({n})' },
  'githubSkill.cancel': { zh: '取消', en: 'Cancel' },
  'githubSkill.done': { zh: '已安装 {name}', en: 'Installed {name}' },
})
interface Preview { pinned: string; repo: string; dir: string; commit: string; files: { path: string; size: number }[] }

export function GithubSkillImport({ source }: { source?: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(source || '')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  async function submit() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      if (preview) {
        const result = await request<{ name: string }>(homeTarget(), '/brain/skills/github/install', { method: 'POST', body: JSON.stringify({ pinned: preview.pinned }) }, { timeoutMs: 130000 })
        setMessage(t('githubSkill.done', { name: result.name }))
        setPreview(null)
        setUrl('')
        setOpen(false)
        window.dispatchEvent(new Event('forsion:skills-changed'))
      } else {
        setPreview(await request<Preview>(homeTarget(), '/brain/skills/github/preview', { method: 'POST', body: JSON.stringify({ url: url.trim() }) }))
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return <section>
    {open ? <form className="gsk-form" onSubmit={e => { e.preventDefault(); void submit() }}>
      <label>{t('githubSkill.url')}<input type="url" required disabled={busy} value={url} onChange={e => { setUrl(e.target.value); setPreview(null); setMessage('') }} /></label>
      {preview && <div className="gsk-files"><strong>{preview.repo}/{preview.dir}</strong> <code>{preview.commit.slice(0, 12)}</code>
        <details><summary>{t('githubSkill.files', { n: preview.files.length })}</summary><ul>{preview.files.map(f => <li key={f.path}>{f.path}</li>)}</ul></details></div>}
      <div className="gsk-form-actions"><button className="btn primary sm" disabled={busy || !url.trim()}>{t(preview ? 'githubSkill.install' : 'githubSkill.preview')}</button>
      <button className="btn ghost sm" type="button" disabled={busy} onClick={() => { setOpen(false); setPreview(null); setMessage('') }}>{t('githubSkill.cancel')}</button></div>
    </form> : <button className="btn ghost sm" type="button" onClick={() => { setOpen(true); setMessage('') }}>{t('githubSkill.open')}{source && ' · ' + new URL(source).pathname.split('/').slice(-2, -1)[0]}</button>}
    {message && <p role="status" className="gsk-message">{message}</p>}
  </section>
}
