// 插件的 ctx.app.pickFolder 主进程那半(2026-11-27):选项只认 title / defaultPath、取消回 null、绝不登记本机项目根。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_FOLDER_TITLE_MAX, pickPluginFolder, pluginFolderDialogOptions } from './pluginFolderPicker'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ABS = process.platform === 'win32' ? 'C:\\Users\\x\\Backups' : '/Users/x/Backups'

describe('pluginFolderDialogOptions', () => {
  it('缺省标题走宿主文案;mac 看得见的 message 与 title 同文;可新建文件夹', () => {
    expect(pluginFolderDialogOptions(undefined, 'Choose a folder')).toEqual({ title: 'Choose a folder', message: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    expect(pluginFolderDialogOptions({ title: '   ' }, '选择文件夹').title).toBe('选择文件夹')
  })

  it('插件标题去控制字符、压空白、按字符截断', () => {
    expect(pluginFolderDialogOptions({ title: ' 备份\n到\t哪里 ' }, 'd').title).toBe('备份 到 哪里')
    const long = pluginFolderDialogOptions({ title: '😀'.repeat(200) }, 'd').title
    expect(Array.from(long)).toHaveLength(PLUGIN_FOLDER_TITLE_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(long.includes('\uFFFD')).toBe(false)
  })

  it('defaultPath 只收绝对路径;相对路径 / 非字符串 / 含 NUL 一律忽略', () => {
    expect(pluginFolderDialogOptions({ defaultPath: ABS }, 'd').defaultPath).toBe(ABS)
    for (const bad of ['Backups', './x', '', 42, `${ABS}\u0000`]) expect(pluginFolderDialogOptions({ defaultPath: bad }, 'd')).not.toHaveProperty('defaultPath')
  })

  it('别的键(包括 purpose)一律丢掉', () => {
    const o = pluginFolderDialogOptions({ purpose: 'project', properties: ['openFile', 'multiSelections'], securityScopedBookmarks: true }, 'd')
    expect(Object.keys(o).sort()).toEqual(['message', 'properties', 'title'])
    expect(o.properties).toEqual(['openDirectory', 'createDirectory'])
  })
})

describe('pickPluginFolder', () => {
  it('选了 → 绝对路径;取消 / 没选 → null', async () => {
    expect(await pickPluginFolder(async () => ({ canceled: false, filePaths: [ABS] }), {}, 'd')).toBe(ABS)
    expect(await pickPluginFolder(async () => ({ canceled: true, filePaths: [] }), {}, 'd')).toBeNull()
    expect(await pickPluginFolder(async () => ({ canceled: false, filePaths: [] }), {}, 'd')).toBeNull()
  })

  it('对话框收到的是清洗后的选项', async () => {
    const show = vi.fn(async () => ({ canceled: true, filePaths: [] }))
    await pickPluginFolder(show, { title: 'Backup to', defaultPath: 'rel', purpose: 'project' }, 'd')
    expect(show).toHaveBeenCalledWith({ title: 'Backup to', message: 'Backup to', properties: ['openDirectory', 'createDirectory'] })
  })

  it('⚠️不登记项目根:模块不碰登记表,main.ts 的 dialog:pickFolder 也不调 registerPickedDirectory', () => {
    const mod = readFileSync(path.join(HERE, 'pluginFolderPicker.ts'), 'utf8')
    expect(mod).not.toMatch(/^import .*unitLocalRoots/m)
    expect(mod).not.toMatch(/registerPickedDirectory\(|registry\.add/)
    const main = readFileSync(path.join(HERE, 'main.ts'), 'utf8')
    const start = main.indexOf("ipcMain.handle('dialog:pickFolder'")
    expect(start, 'main.ts 里找不到 dialog:pickFolder').toBeGreaterThan(0)
    const body = main.slice(start, main.indexOf('\n  })', start))
    expect(body).toContain('pickPluginFolder(')
    expect(body).not.toContain('registerPickedDirectory')
    expect(body).not.toContain('localProjectRegistry')
  })
})
