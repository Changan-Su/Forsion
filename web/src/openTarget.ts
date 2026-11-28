/**
 * 网页文件地址 `?vault=<库>&note=<路径>`:只说「想看哪一页」,不含凭据,能不能看由服务端判。
 * 邀请页同意后、「与我共享」跨库点击、复制页面链接都走这一条。
 * 账号就位后再取参数(活动库键按账号分作用域);主应用起来后才打开,打不开就提示并留在工作区。
 */
import { isSafeVaultPath } from '@/deepLinkPlan'
import { activeCloudViewPath } from './amadeus/cloudBridge'
import { rememberCloudLibrary, setPendingOpenNote } from './amadeus/cloudScope'

export function fileAddress(base: string, vaultId: string, path: string): string {
  const url = new URL(base, location.href)
  url.searchParams.set('vault', vaultId)
  url.searchParams.set('note', path)
  url.hash = ''
  return url.href
}

export interface OpenTarget { vault: string; note: string }

/** 取走地址里的目标并定好活动库;地址栏清掉,刷新不再把人拽回这一页。 */
export function takeOpenTarget(): OpenTarget | null {
  const url = new URL(location.href)
  const vault = url.searchParams.get('vault'), note = url.searchParams.get('note')
  if (!vault || !note) return null
  url.searchParams.delete('vault')
  url.searchParams.delete('note')
  history.replaceState(history.state, '', url.href)
  if (!isSafeVaultPath(note)) return null
  // 地址里的 note 是整库里的服务端路径:先选这个库的整库视图;它落在某个原位置库里时,桥选库那一步改开那个库(pendingOpenNote)
  rememberCloudLibrary(vault)
  setPendingOpenNote(vault, note)
  ;(window as { __FORSION_OPEN_TARGET__?: boolean }).__FORSION_OPEN_TARGET__ = true
  return { vault, note }
}

export async function openTargetWhenReady({ vault, note }: OpenTarget): Promise<void> {
  const [{ resolveDeepLink }, { useApp }, { translate }] = await Promise.all([
    import('@/deepLinkInstall'), import('@/stores/appStore'), import('@/i18n'),
  ])
  // 没有权限时活动库会回落到自己的库,那里可能有同路径的文件,不能把它当成目标打开。
  const active = await window.amadeusCollab?.activeVaultId().catch(() => null)
  if (active && active !== vault) { useApp.getState().toast(translate('deeplink.noteDenied'), true); return }
  // 服务端路径 → 当前库视图里的路径(原位置库以 X/ 为根);不在这个视图里 = 打不开
  const viewNote = activeCloudViewPath(note, vault)
  if (viewNote === null) { useApp.getState().toast(translate('deeplink.noteDenied'), true); return }
  note = viewNote
  // Space 与文件清单都是异步到位的。手机壳没有 Dockview,whenWorkspaceReady 等不到,这里统一短间隔重试。
  const deadline = Date.now() + 12_000
  do {
    await resolveDeepLink({ kind: 'space', ref: 'amadeus', params: {} }).catch(() => false)
    if (await resolveDeepLink({ kind: 'note', ref: note, params: {} }).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  } while (Date.now() < deadline)
  useApp.getState().toast(translate('deeplink.noteDenied'), true)
}
