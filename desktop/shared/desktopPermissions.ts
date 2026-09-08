/** OS grants belong to the process using them, not to the agent conversation. */
export type DesktopPermissionId = 'computerAccessibility' | 'computerScreen' | 'microphone' | 'camera' | 'screen'
export type DesktopPermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'unverified' | 'unavailable' | 'not-required'
export interface DesktopPermissionsSnapshot {
  platform: string
  appName: string
  computerUseAvailable: boolean
  helperInstalled: boolean
  helperRunning: boolean
  permissions: Record<DesktopPermissionId, DesktopPermissionState>
  helperError?: 'not-installed' | 'not-running' | 'outdated' | 'wrong-identity' | 'unreachable'
}
export interface DesktopPermissionRequestOptions { locale?: 'zh' | 'en'; mode?: 'light' | 'dark' }
export const DESKTOP_PERMISSION_IDS: readonly DesktopPermissionId[] = [
  'computerAccessibility', 'computerScreen', 'microphone', 'camera', 'screen',
]
export const isDesktopPermissionId = (value: unknown): value is DesktopPermissionId =>
  typeof value === 'string' && DESKTOP_PERMISSION_IDS.includes(value as DesktopPermissionId)
