/**
 * Dev-only visual harness:桌面新对话的「运行位置」胶囊 —— 真 RunLocationPicker / ProjectSelector / ExtraFolders + 真 store
 * (appStore、目标解析层、设备状态)+ 生产 CSS,摆在真的 `.newchat-projectbar` 里;下面那块输入卡只是占位。
 * window.tangu 是桌面形态的桩:名册、`unitRelay`(给一个本机回环地址,请求由台架脚本的路由桩应答)。不连主进程。
 * ?dark / ?lang=en / ?zoom=1.1 / ?signedout(没登录:没有中转口)/ ?solo(账号下没有别的电脑)/ ?long(多一台名字很长的)。
 * 截图与断言:scripts/run-location-pill.check.cjs(node scripts/e2e-editor.cjs --check=run-location-pill)。
 * ?sidebar:工作区的真 DeviceSessionSections,离线折叠回归(check:device-sidebar)。
 * 整条链路(主进程中转口 × 真 Electron)见 scripts/run-location.e2e.cjs。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal, translate } from './i18n'
import './i18n.generated'
import './styles/base.css'
import './views/chat2/chat2.css'
import './views/chat2/composer2.css'
import { applyTheme } from './theme/loader'

const params = new URLSearchParams(location.search)
const MINI = '7f0e8a52-0000-4000-8000-00000000000a'
const LOCAL = 'http://127.0.0.1:41000'
const RELAY = { base: 'http://127.0.0.1:41234', token: 'harness-relay-secret', accountId: 'harness::u-42' }
const units = params.has('solo') ? [] : [
  { id: MINI, name: 'Mac mini', platform: 'darwin', kind: 'desktop', online: true, capsLive: true, caps: { engine: 'ready' } },
  { id: '7f0e8a52-0000-4000-8000-00000000000b', name: 'ThinkPad X1', platform: 'win32', kind: 'desktop', online: false },
  { id: '7f0e8a52-0000-4000-8000-00000000000c', name: 'Pixel', platform: 'android', kind: 'phone', online: true },
  // ?long:名字很长的那台(菜单行与胶囊都只能省略,不许折行 / 撑宽)
  ...(params.has('long') ? [{ id: '7f0e8a52-0000-4000-8000-00000000000d', name: 'Qingyuan 的 MacBook Pro 16 英寸(工作用)', platform: 'darwin', kind: 'desktop', online: true, capsLive: true, caps: { engine: 'ready' } }] : []),
]
// 桩必须先于 appStore 求值装好(currentPlatform / 门控都读它)
;(window as unknown as { tangu: unknown }).tangu = {
  unitsList: async () => (params.has('signedout') ? { status: 401, json: null } : { status: 200, json: { units } }),
  unitRelay: async () => (params.has('signedout') ? null : RELAY),
  unitHostStatus: async () => ({ running: false, connected: false, unitId: null, lastError: null, webPort: null, lanUrl: null }),
  authStatus: async () => ({ loggedIn: !params.has('signedout'), tokenValid: true }),
  pickDirectory: async () => null,
}
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', params.has('dark') ? 'dark' : 'light')
if (params.get('zoom')) document.documentElement.style.zoom = params.get('zoom')!

void (async () => {
  const [{ useApp }, T, { RunLocationPicker }, { ProjectSelector }, { ExtraFolders }, { useRemoteNewChatWorkspaces }] = await Promise.all([
    import('./stores/appStore'), import('./services/engine/targets'), import('./components/RunLocationPicker'),
    import('./components/ProjectSelector'), import('./components/ExtraFolders'), import('./stores/newChatWorkspaces'),
    import('./tangu/store/standalone'), // 不走 installEngine:自己装 Tangu 的 store 半身(界面热更新 3c),同样排在打桩之后
  ])
  useApp.getState().setTr(translate) // main.tsx 做的那一步:store 里的文案(默认工作区的名字)靠它
  useApp.setState({
    cfg: { backendUrl: LOCAL, token: 'engine-token', modelId: 'm1' },
    desktopConfig: { mode: 'managed', backendUrl: LOCAL, token: 'engine-token', cloudUrl: 'https://cloud.harness.test' } as never,
    desktopMode: 'managed', sessionMode: 'work', connState: 'ok', cfgLoaded: true,
    homeDir: '/Users/me', defaultWsDir: '/Users/me/Forsion',
    sessions: [{ id: 'local-1', title: '本机上的会话', project_path: '/Users/me/code/forsion', project_name: 'forsion', created_at: '2026-10-13T08:00:00Z', updated_at: '2026-10-13T08:00:00Z' }] as never,
  })
  await T.refreshDesktopRelay()
  ;(window as unknown as Record<string, unknown>).__runloc = { useApp, T }

  if (params.has('sidebar')) {
    await import('./styles/sidebar2.css')
    const [{ DeviceSessionSections }, { useDeviceSessions }, { noteDeviceProbe }] = await Promise.all([
      import('./views/chat2/DeviceSessionSections'), import('./stores/deviceSessionsStore'), import('./services/deviceMarks'),
    ])
    const offline = Array.from({ length: 14 }, (_, i) => ({
      id: `7f0e8a52-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
      name: i === 1 ? 'DESKTOP-EEUIJMF' : 'MacBook-Pro.local', platform: i === 1 ? 'win32' : 'darwin', kind: 'desktop' as const, online: false,
    }))
    useDeviceSessions.setState({ units: [units[0], ...offline] as never, byUnit: {}, refresh: async () => {} })
    noteDeviceProbe(MINI, { ok: true })
    ;(window as unknown as Record<string, unknown>).__deviceSidebar = {
      setOnline: (id: string, online: boolean) => useDeviceSessions.setState((s) => ({ units: s.units!.map((u) => u.id === id ? { ...u, online } : u) })),
      setAllOnline: () => useDeviceSessions.setState((s) => ({ units: s.units!.map((u) => ({ ...u, online: true })) })),
      offlineId: offline[0].id,
    }
    createRoot(document.getElementById('root')!).render(
      <LocaleProvider>
        <div className="t2sw" style={{ width: 300, height: '100vh', background: 'var(--sidebar-bg)' }}>
          <div className="t2s-side"><div className="t2s-scroll">
            <DeviceSessionSections activeId={null} runningIds={new Set()} unreadIds={new Set()} />
          </div></div>
        </div>
      </LocaleProvider>,
    )
    return
  }

  const Bar = (): React.ReactElement => {
    const s = useApp()
    const remoteWs = useRemoteNewChatWorkspaces()
    return (
      <div className="t2-chat-view" style={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div className="composer-anchor" data-harness-anchor style={{ paddingBottom: 24 }}>
          <div className="newchat-projectbar">
            <div className="newchat-projectbar-inner">
              <RunLocationPicker />
              <ProjectSelector
                workspaces={remoteWs ?? s.workspaces()}
                value={s.newChatWs?.key ?? null}
                onChange={(w) => s.setNewChatWs(w)}
                onAddProject={!remoteWs ? () => {} : undefined}
                onAddCloudProject={remoteWs ? undefined : () => {}}
              />
              <ExtraFolders />
            </div>
          </div>
          {/* 占位:真输入卡(Composer2)不在这个台架里,这块只给胶囊一个「贴在输入卡上方」的参照 */}
          <div className="t2c-inner"><div className="t2c-card" data-harness-card style={{ minHeight: 96, padding: '14px 16px', color: 'var(--text-faint)' }}>（输入卡占位）</div></div>
        </div>
      </div>
    )
  }
  createRoot(document.getElementById('root')!).render(<LocaleProvider><Bar /></LocaleProvider>)
})()
