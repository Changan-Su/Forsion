import { app, desktopCapturer, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { askHelper, helperSocketPath } from './computerUse'
import { builtinBundleSources } from './builtinPlugins'
import { PermissionGuide } from './permissionGuide'
import { isDesktopPermissionId, type DesktopPermissionId, type DesktopPermissionRequestOptions, type DesktopPermissionState, type DesktopPermissionsSnapshot } from '../shared/desktopPermissions'

const exec = promisify(execFile)
type Rect = { x: number; y: number; width: number; height: number }
interface HelperStatus {
  accessibility?: boolean
  screenRecordingPreflight?: boolean
  screenRecordingCapturable?: boolean
  source?: { attribution?: string; pid?: number; executablePath?: string }
  settingsWindow?: Rect
  settingsFrontmost?: boolean
}

/** Same selection order as the bundled helper-path.mjs, including standard user installs. */
export function permissionHelperAppPath(env = process.env, homeDir = os.homedir()): string {
  if (env.PI_COMPUTER_USE_HELPER_APP_PATH?.trim()) return path.resolve(env.PI_COMPUTER_USE_HELPER_APP_PATH.trim())
  const system = '/Applications/tangu-computer-use.app'
  try {
    if (existsSync(system)) { accessSync(path.dirname(system), constants.W_OK); return system }
  } catch { /* A non-writable system install must not win over the user's copy. */ }
  return path.join(homeDir, 'Applications', 'tangu-computer-use.app')
}

export function normalizeMediaPermission(value: unknown): DesktopPermissionState {
  return ['granted', 'denied', 'restricted', 'not-determined'].includes(String(value))
    ? value as DesktopPermissionState : 'unknown'
}

/** A preflight success alone is not proof of usable ScreenCaptureKit access. */
export function helperPermissionStates(raw: HelperStatus, verification?: { pid: number; granted: boolean }): Pick<DesktopPermissionsSnapshot['permissions'], 'computerAccessibility' | 'computerScreen'> {
  if (raw.source?.attribution !== 'helper-app') return { computerAccessibility: 'unknown', computerScreen: 'unknown' }
  return {
    computerAccessibility: raw.accessibility === true ? 'granted' : raw.accessibility === false ? 'denied' : 'unknown',
    computerScreen: verification && verification.pid === raw.source.pid ? verification.granted ? 'granted' : 'denied'
      : raw.screenRecordingPreflight === true ? 'unverified'
      : raw.screenRecordingPreflight === false ? 'denied' : 'unknown',
  }
}

const MAC_PANES: Record<DesktopPermissionId, string> = {
  computerAccessibility: 'Privacy_Accessibility', computerScreen: 'Privacy_ScreenCapture',
  microphone: 'Privacy_Microphone', camera: 'Privacy_Camera', screen: 'Privacy_ScreenCapture',
}
const helperCommand = (cmd: string, args: Record<string, unknown> = {}, timeout = 2500): Promise<unknown> =>
  askHelper(helperSocketPath(), { cmd, ...args }, timeout)

export class DesktopPermissions {
  private verification?: { pid: number; granted: boolean }
  private verifiedAt = 0
  private readPending?: Promise<{ snapshot: DesktopPermissionsSnapshot; settingsWindow?: Rect; settingsFrontmost?: boolean }>
  private setupPending?: Promise<void>
  private actionPending = false
  private verifyPending?: Promise<DesktopPermissionsSnapshot>
  private generation = 0
  private guide: PermissionGuide

  constructor(private computerUseAvailable: boolean, returnToApp: () => void) {
    this.guide = new PermissionGuide({
      read: () => this.read(), verify: (id) => id === 'computerScreen' ? this.verify() : this.read().then((r) => r.snapshot),
      // This button only reopens the selected pane. It cannot launch another installer/prompt.
      open: (id) => this.openPane(id), returnToApp,
    })
  }

  read(): Promise<{ snapshot: DesktopPermissionsSnapshot; settingsWindow?: Rect; settingsFrontmost?: boolean }> {
    this.readPending ??= this.readNow().finally(() => { this.readPending = undefined })
    return this.readPending
  }

  private async readNow() {
    const mac = process.platform === 'darwin'
    const windows = process.platform === 'win32'
    const snapshot: DesktopPermissionsSnapshot = {
      platform: process.platform,
      // TCC lists Electron during development, not the product's display name.
      appName: app.isPackaged ? app.getName() : path.basename(process.execPath),
      computerUseAvailable: this.computerUseAvailable && (mac || windows),
      helperInstalled: mac && existsSync(path.join(permissionHelperAppPath(), 'Contents/MacOS/bridge')),
      helperRunning: false,
      permissions: {
        computerAccessibility: mac ? 'unknown' : windows ? 'not-required' : 'unavailable',
        computerScreen: mac ? 'unknown' : windows ? 'not-required' : 'unavailable',
        microphone: mac || windows ? 'unknown' : 'unavailable', camera: mac || windows ? 'unknown' : 'unavailable', screen: mac ? 'unknown' : 'not-required',
      },
    }
    if (mac || windows) {
      for (const kind of ['microphone', 'camera', ...(mac ? ['screen'] : [])] as const) {
        try { snapshot.permissions[kind as 'microphone' | 'camera' | 'screen'] = normalizeMediaPermission(systemPreferences.getMediaAccessStatus(kind as 'microphone' | 'camera' | 'screen')) } catch { /* unavailable is not denied */ }
      }
    }
    if (!mac || !snapshot.computerUseAvailable) return { snapshot }
    // Do not even connect to a missing socket. Opening settings must never install/start CU.
    if (!existsSync(helperSocketPath())) {
      snapshot.helperError = snapshot.helperInstalled ? 'not-running' : 'not-installed'
      return { snapshot }
    }
    try {
      const raw = await helperCommand('permissionStatus') as HelperStatus
      snapshot.helperRunning = true
      if (raw.source?.attribution !== 'helper-app') snapshot.helperError = 'wrong-identity'
      // Never keep a green badge indefinitely after a live probe or across a helper restart.
      if (Date.now() - this.verifiedAt > 30_000) this.verification = undefined
      Object.assign(snapshot.permissions, helperPermissionStates(raw, this.verification))
      return { snapshot, settingsWindow: raw.settingsWindow, settingsFrontmost: raw.settingsFrontmost }
    } catch (error) {
      const code = (error as { code?: string }).code
      snapshot.helperError = code === 'unknown_command' ? 'outdated'
        : code === 'ENOENT' || code === 'ECONNREFUSED' ? 'not-running' : 'unreachable'
      return { snapshot }
    }
  }

  private install(): Promise<void> {
    if (this.setupPending) return this.setupPending
    const root = builtinBundleSources({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })
      .find((dir) => existsSync(path.join(dir, 'scripts/setup-helper.mjs')))
    if (!root) return Promise.reject(new Error('The bundled Computer Use installer is missing. Reinstall Forsion and retry.'))
    const work = new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts/setup-helper.mjs'), '--runtime'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BUN_BE_BUN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      })
      child.unref()
      let output = ''
      const collect = (data: Buffer) => { output = (output + data.toString()).slice(-12_000) }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.once('error', reject)
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(output.trim() || `Computer Use installer exited with ${code}`)))
    })
    // Keep the shared promise tied to the process. A UI timeout must not interrupt codesign.
    this.setupPending = work.finally(() => { this.setupPending = undefined })
    return this.setupPending
  }

  private async prepareHelper(stillWanted: () => boolean, locale: 'zh' | 'en', repaired = false): Promise<boolean> {
    const { snapshot } = await this.read()
    if (!stillWanted()) return false
    const externalSocket = helperSocketPath() !== helperSocketPath({})
    if (externalSocket && (!snapshot.helperRunning || snapshot.helperError)) {
      throw new Error('The configured external Computer Use helper is unavailable or outdated. Update and start that helper before retrying.')
    }
    if (snapshot.helperError === 'wrong-identity') throw new Error('Computer Use is running under another app. Close that helper and retry from Forsion.')
    if (snapshot.helperError === 'unreachable') throw new Error('Computer Use is not responding. Finish any active computer task, then retry.')
    if (snapshot.helperError === 'outdated') {
      // Old helpers have no in-flight-task API. liveView.active=false does NOT prove idle:
      // the very first look may still be building an AX tree. Only explicit consent may restart it.
      const zh = locale === 'zh'
      const answer = await dialog.showMessageBox({
        type: 'question', noLink: true, defaultId: 0, cancelId: 0,
        buttons: zh ? ['稍后设置', '更新并重启助手'] : ['Set up later', 'Update and restart helper'],
        message: zh ? '更新 Computer Use 权限助手' : 'Update the Computer Use permission helper',
        detail: zh
          ? '此版本需要更新助手才能设置权限。更新会重启助手并中断正在执行的电脑操作，请先完成相关任务。系统可能要求重新授权。'
          : 'This version needs a helper update to set up permissions. Updating restarts the helper and interrupts any computer task in progress. Finish those tasks first. macOS may ask you to grant access again.',
      })
      if (answer.response !== 1 || !stillWanted()) return false
      await helperCommand('shutdown')
      // Wait for the old socket server to exit before replacing its executable.
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    if (!snapshot.helperInstalled || snapshot.helperError === 'outdated') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.install(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Computer Use setup is still running. Wait a moment, then retry.')), 180_000)
        })])
      } finally { clearTimeout(timer) }
    }
    if (!stillWanted()) return false
    if (!snapshot.helperRunning || snapshot.helperError === 'outdated') {
      await mkdir(path.dirname(helperSocketPath()), { recursive: true })
      if (!stillWanted()) return false
      await exec('/usr/bin/open', ['-n', '-g', permissionHelperAppPath(), '--args', 'serve', '--socket', helperSocketPath()], { timeout: 10_000 })
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const raw = await helperCommand('permissionStatus') as HelperStatus
        if (raw.source?.attribution !== 'helper-app') throw new Error('Computer Use must be launched as its own app for macOS permissions.')
        return true
      } catch (error) {
        if ((error as { code?: string }).code === 'unknown_command') {
          if (!repaired) return this.prepareHelper(stillWanted, locale, true)
          throw error
        }
        if (attempt === 19) throw error
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    return false
  }

  private async openPane(id: DesktopPermissionId): Promise<void> {
    if (process.platform === 'darwin') await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${MAC_PANES[id]}`)
    else if (process.platform === 'win32' && (id === 'microphone' || id === 'camera')) {
      await shell.openExternal(id === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy-webcam')
    }
  }

  async request(id: DesktopPermissionId, options: DesktopPermissionRequestOptions = {}): Promise<DesktopPermissionsSnapshot> {
    if (this.actionPending) throw new Error('A permission request is already in progress.')
    this.actionPending = true
    const generation = ++this.generation
    const current = () => generation === this.generation
    try {
      if (process.platform !== 'darwin') {
        await this.openPane(id)
        return (await this.read()).snapshot
      }
      if (id === 'computerAccessibility' || id === 'computerScreen') {
        if (!this.computerUseAvailable) throw new Error('Computer Use is unavailable in this product.')
        if (!await this.prepareHelper(current, options.locale === 'zh' ? 'zh' : 'en') || !current()) return (await this.read()).snapshot
        // Request only the selected permission; an accessibility click cannot prompt for recording.
        await helperCommand('registerPermissions', { kind: id === 'computerAccessibility' ? 'accessibility' : 'screenRecording' }, 15_000)
      } else if (id === 'microphone' || id === 'camera') {
        const state = systemPreferences.getMediaAccessStatus(id)
        if (state === 'not-determined') await systemPreferences.askForMediaAccess(id)
        if (systemPreferences.getMediaAccessStatus(id) === 'granted') return (await this.read()).snapshot
      } else if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        // Enumerate sources only on this explicit screen-access action; discard all returned sources.
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      }
      if (!current()) return (await this.read()).snapshot
      await this.openPane(id)
      if (current()) await this.guide.show(id, options)
      return (await this.read()).snapshot
    } finally { this.actionPending = false }
  }

  /** Explicit user action only: never called by page polling or focus refresh. */
  verify(): Promise<DesktopPermissionsSnapshot> {
    this.verifyPending ??= this.verifyNow().finally(() => { this.verifyPending = undefined })
    return this.verifyPending
  }

  private async verifyNow(): Promise<DesktopPermissionsSnapshot> {
    if (process.platform !== 'darwin' || !this.computerUseAvailable) return (await this.read()).snapshot
    const { snapshot } = await this.read()
    if (!snapshot.helperRunning || snapshot.helperError) throw new Error('Open Computer Use permission settings first, then verify access.')
    const raw = await helperCommand('checkPermissions', { fresh: true }, 15_000) as HelperStatus
    this.verification = raw.source?.attribution === 'helper-app' && typeof raw.source.pid === 'number'
      ? { pid: raw.source.pid, granted: raw.screenRecordingCapturable === true } : undefined
    this.verifiedAt = Date.now()
    // readNow applies the live result only if the current helper still has the same PID and
    // canonical identity. Never copy an old process's grant onto a restarted/replaced helper.
    return (await this.read()).snapshot
  }

  closeGuide(): void { this.generation++; this.guide.close() }
}

export function registerDesktopPermissions(opts: {
  isTrustedSender: (event: Electron.IpcMainInvokeEvent) => boolean
  computerUseAvailable: boolean
  returnToApp: () => void
}): DesktopPermissions {
  const permissions = new DesktopPermissions(opts.computerUseAvailable, opts.returnToApp)
  let guideOwner: Electron.WebContents | undefined
  const closeOwnedGuide = () => {
    guideOwner?.removeListener('destroyed', closeOwnedGuide)
    guideOwner?.removeListener('did-start-navigation', closeOwnedGuide)
    guideOwner = undefined
    permissions.closeGuide()
  }
  const trusted = (event: Electron.IpcMainInvokeEvent) => { if (!opts.isTrustedSender(event)) throw new Error('Untrusted permission request') }
  ipcMain.handle('permissions:status', (event) => { trusted(event); return permissions.read().then((r) => r.snapshot) })
  ipcMain.handle('permissions:request', (event, id: unknown, options?: DesktopPermissionRequestOptions) => {
    trusted(event)
    if (!isDesktopPermissionId(id)) throw new Error('Unknown permission')
    if (guideOwner !== event.sender) {
      closeOwnedGuide()
      guideOwner = event.sender
      guideOwner.on('destroyed', closeOwnedGuide)
      guideOwner.on('did-start-navigation', closeOwnedGuide)
    }
    return permissions.request(id, { locale: options?.locale === 'zh' ? 'zh' : 'en', mode: options?.mode === 'dark' ? 'dark' : 'light' })
  })
  ipcMain.handle('permissions:verify', (event) => { trusted(event); return permissions.verify() })
  ipcMain.handle('permissions:closeGuide', (event) => { trusted(event); if (guideOwner === event.sender) closeOwnedGuide() })
  app.on('before-quit', closeOwnedGuide)
  return permissions
}
