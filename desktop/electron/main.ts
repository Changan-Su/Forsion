/**
 * Tangu 桌面 GUI — Electron 主进程(薄)。
 * 只负责:建窗 + 本地配置(后端 URL / token / model)持久化(IPC)。
 * agent 调用由 renderer 直连 standalone HTTP/SSE(localhost),不经主进程代理。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

interface TanguConfig {
  backendUrl: string
  token: string
  modelId: string
}
const DEFAULT_CONFIG: TanguConfig = { backendUrl: 'http://localhost:8787', token: '', modelId: '' }

const configPath = (): string => join(app.getPath('userData'), 'tangu-desktop-config.json')

async function loadConfig(): Promise<TanguConfig> {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath(), 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
async function saveConfig(patch: Partial<TanguConfig>): Promise<TanguConfig> {
  const merged = { ...(await loadConfig()), ...patch }
  await mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
  await writeFile(configPath(), JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F5EFE4', // 宣纸白,避免白屏闪烁
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<TanguConfig>) => saveConfig(patch))

  // ── 方案 B(打包版自启后端)留位 ──
  //   import { spawn } from 'node:child_process'
  //   const exe = app.isPackaged ? join(process.resourcesPath, 'tangu/standalone/main.js')
  //                              : join(__dirname, '../../../dist/standalone/main.js')
  //   const tangu = spawn(process.execPath, [exe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  //   app.on('before-quit', () => tangu?.kill())

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
