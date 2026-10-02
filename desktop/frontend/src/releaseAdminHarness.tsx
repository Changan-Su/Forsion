/** Dev-only acceptance harness: real Website panel, native Workspace/Extend View and Amadeus editor.
 * Paired with server/scripts/preview-releases.ts; all SQL/media state stays in the local fixture. */
import './harnessBridge'
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { FileText } from 'lucide-react'
import { WorkspaceHost } from '@lcl/engine/WorkspaceHost'
import { registerView, useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine/types'
import { mountPluginMarkdownEditor } from './amadeus/plugins/markdownEditorSurface'
import { setLocaleGlobal, useI18n, translate } from './i18n'
import { setEngineI18n } from '@lcl/engine/i18nSeam'
import './styles/base.css'
import './amadeus-host.css'
import '@lcl/engine/engine.css'

const origin =
  new URLSearchParams(location.search).get('backend') || 'http://localhost:3118'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
  throw new Error('This harness accepts a localhost fixture only')
setLocaleGlobal('zh')
setEngineI18n(useI18n, translate)
const globals = window as unknown as {
  ForsionAdminRegistry: { register(panel: any): void }
  releasePanel: any
}
globals.ForsionAdminRegistry = {
  register(panel) {
    globals.releasePanel = panel
  },
}
const style = document.createElement('style')
style.textContent =
  '.hidden{display:none!important}.release-admin-preview{padding:16px;overflow:auto;height:100%;min-width:0}.fsa-adm{--surface:var(--bg-card);--primary:var(--accent)}.fsa-adm input:not([type=file]),.fsa-adm textarea{display:block;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)}.fsa-adm button{padding:7px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text);cursor:pointer}.website-tab[aria-selected=true]{background:var(--accent-light)}.text-admin-muted{color:var(--text-muted)}.fsa-adm .section-title{margin:8px 0}.fsa-adm label{font-size:var(--ui-font-meta);font-weight:500}.release-preview-notice{padding:12px;font-size:var(--ui-font-meta);color:var(--text-muted)}'
document.head.appendChild(style)
for (const path of ['/fixture/panel-lib.js', '/fixture/panel.js'])
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = origin + path
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Error('Start the isolated release preview server'))
    document.head.appendChild(script)
  })
function Admin({ extendView }: ViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const panel = globals.releasePanel
    void panel.mount(ref.current, {
      initialTab: 'releases',
      locale: () => 'zh',
      publicOrigin: origin,
      resolveUrl: (p: string) => new URL(p, origin).href,
      fetch: async (path: string, options: RequestInit = {}) => {
        const headers = new Headers(options.headers)
        headers.set('Authorization', 'Bearer local-release-preview')
        if (options.body && !(options.body instanceof FormData))
          headers.set('Content-Type', 'application/json')
        const r = await fetch(origin + path, { ...options, headers })
        const body = await r.json()
        if (!r.ok) throw new Error(body.detail || r.statusText)
        return body
      },
      toast: (message: string) => {
        const node = document.getElementById('release-preview-status')
        if (node) node.textContent = message
      },
      extendView,
      markdownEditor: { mount: mountPluginMarkdownEditor },
    })
    return () => panel.unmount?.()
  }, [extendView])
  return (
    <div className="release-admin-preview fsa-adm">
      <p className="release-preview-notice">
        本地验收 · 独立临时数据库。使用原生 Amadeus 编辑器与 Extend
        View，修改不会发布到线上。
        <a
          href="http://localhost:5191/releases/?lang=zh"
          target="_blank"
          rel="noreferrer"
        >
          查看本地官网 ↗
        </a>
      </p>
      <div id="release-preview-status" role="status" />
      <div ref={ref} />
    </div>
  )
}
registerView({
  type: 'releases-admin-preview',
  displayName: 'Website · 更新动态',
  icon: FileText,
  factory: (props) => <Admin {...props} />,
})
createRoot(document.getElementById('root')!).render(
  <div
    className="am-app tangu-lovable"
    data-mode="light"
    style={{ position: 'fixed', inset: 0, display: 'flex' }}
  >
    <WorkspaceHost
      dark={false}
      soft={false}
      buildDefault={() =>
        useWorkspace.getState().openView('releases-admin-preview', {}, 'main')
      }
    />
  </div>,
)
