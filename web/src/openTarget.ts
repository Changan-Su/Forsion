/**
 * 网页文件地址 `?vault=<库>&note=<路径>`:只说「想看哪一页」,不含凭据,能不能看由服务端判。
 * 邀请页同意后、「与我共享」跨库点击、复制页面链接都走这一条。
 * 账号就位后再取参数(活动库键按账号分作用域);主应用起来后才打开,打不开就提示并留在工作区。
 */
import { contentStorageKey } from '@lcl/engine/contentStorageScope'
import { isSafeVaultPath } from '@/deepLinkPlan'
import { ACTIVE_VAULT_KEY } from './amadeus/cloudBridge'

export function fileAddress(base: string, vaultId: string, path: string): string {
  const url = new URL(base, location.href)
  url.searchParams.set('vault', vaultId)
  url.searchParams.set('note', path)
  url.hash = ''
  return url.href
}

/** 取走地址里的目标并定好活动库;地址栏清掉,刷新不再把人拽回这一页。 */
export function takeOpenTarget(): string | null {
  const url = new URL(location.href)
  const vault = url.searchParams.get('vault'), note = url.searchParams.get('note')
  if (!vault || !note) return null
  url.searchParams.delete('vault')
  url.searchParams.delete('note')
  history.replaceState(history.state, '', url.href)
  if (!isSafeVaultPath(note)) return null
  try { localStorage.setItem(contentStorageKey(ACTIVE_VAULT_KEY), vault) } catch { /* private mode */ }
  return note
}

export async function openTargetWhenReady(note: string): Promise<void> {
  const [{ resolveDeepLink }, { useApp }, { translate }] = await Promise.all([
    import('@/deepLinkInstall'), import('@/stores/appStore'), import('@/i18n'),
  ])
  // Space 与文件清单都是异步到位的。手机壳没有 Dockview,whenWorkspaceReady 等不到,这里统一短间隔重试。
  const deadline = Date.now() + 12_000
  do {
    await resolveDeepLink({ kind: 'space', ref: 'amadeus', params: {} }).catch(() => false)
    if (await resolveDeepLink({ kind: 'note', ref: note, params: {} }).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  } while (Date.now() < deadline)
  useApp.getState().toast(translate('deeplink.noteDenied'), true)
}
