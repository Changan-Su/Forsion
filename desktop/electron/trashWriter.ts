/**
 * 回收站的桌面这一半(10-28 手动卸载规范):卸载 Forsion 插件时主进程把插件文件、设置、库里的工作文件夹挪进引擎同一个
 * 回收站目录 `<tanguDataDir>/trash/<id>/`,restorer='desktop' —— 恢复也由主进程来(它知道笔记库在哪、恢复后要重扫插件)。
 * ⚠️ 格式与 tangu-agent/src/services/trash.ts 是同一份契约(meta.json 字段、items/<序号>、id 形状),改一边必须改另一边;
 * 列出、彻底删除、30 天到期清理只在引擎。
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tanguDataDir } from './forsionHome'

export interface DesktopTrashEntry {
  id: string; kind: 'plugin'; ref: string; name: string; deletedAt: number; size: number
  restorer: 'desktop'; items: Array<{ from: string; stored: string; role?: string; parent?: string }>; extra?: Record<string, unknown>
}

const trashDir = (): string => path.join(tanguDataDir(), 'trash')
const SAFE_ID = /^[a-z]+-[A-Za-z0-9._-]{1,80}-\d+-[0-9a-f]{8}$/
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

async function pathSize(p: string): Promise<number> {
  const st = await fs.lstat(p).catch(() => null)
  if (!st) return 0
  if (!st.isDirectory()) return st.size
  let n = 0
  for (const e of await fs.readdir(p)) n += await pathSize(path.join(p, e))
  return n
}

/** 同盘 rename;跨盘(笔记库在网盘 / 外接盘)退回复制后删除。复制失败删掉半份(源还完整);删源失败照样抛,但整份已在 to。 */
async function move(from: string, to: string): Promise<void> {
  try { await fs.rename(from, to) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV' || await exists(to)) throw e
    try { await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false }) }
    catch (c) { await fs.rm(to, { recursive: true, force: true }).catch(() => {}); throw c }
    await fs.rm(from, { recursive: true, force: true })
  }
}

/** 挪进回收站;一件都不在就不留条目(null)。先写记录再挪(挪到一半出事,条目照样列得出、恢复得了);
 *  中途失败把已挪的挪回去再抛,有一件没挪回去(或失败那件已整份进来)就留着条目,不删唯一的那份。 */
export async function moveToDesktopTrash(input: { ref: string; name: string; paths: Array<{ path: string; role: string }>; extra?: Record<string, unknown> }): Promise<DesktopTrashEntry | null> {
  const present: Array<{ path: string; role: string }> = []
  for (const p of input.paths) if (await exists(p.path)) present.push(p)
  if (!present.length) return null
  // 回收站要是个软链,卸载就把插件和库里的数据挪到链接指向的地方去了:必须是真目录(同引擎)。
  await fs.mkdir(trashDir(), { recursive: true })
  if (!(await fs.lstat(trashDir())).isDirectory()) throw new Error('Trash is not a regular directory')
  const id = `plugin-${input.ref.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-${Date.now()}-${randomUUID().slice(0, 8)}`
  const dir = path.join(trashDir(), id)
  await fs.mkdir(path.join(dir, 'items'), { recursive: true })
  let size = 0
  const items: DesktopTrashEntry['items'] = []
  for (const [i, p] of present.entries()) {
    size += await pathSize(p.path)
    const parent = await fs.realpath(path.dirname(p.path)).catch(() => undefined)
    items.push({ from: path.resolve(p.path), stored: `items/${i}`, role: p.role, ...(parent ? { parent } : {}) })
  }
  const entry: DesktopTrashEntry = { id, kind: 'plugin', ref: input.ref, name: input.name, deletedAt: Date.now(), size, restorer: 'desktop', items, ...(input.extra ? { extra: input.extra } : {}) }
  try { await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(entry, null, 2), 'utf8') }
  catch (e) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); throw e }
  let moved = 0
  try {
    for (const it of items) { await move(it.from, path.join(dir, it.stored)); moved++ }
  } catch (e) {
    let safe = !(await exists(path.join(dir, items[moved].stored)))
    for (let i = moved - 1; i >= 0; i--) await move(path.join(dir, items[i].stored), items[i].from).catch(() => { safe = false })
    if (safe) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  return entry
}

/** 放回原处(被占了就落到「原名-2」,文件保留扩展名);只认 restorer='desktop' 的条目。中途失败可重试。 */
export async function restoreDesktopTrash(id: string): Promise<DesktopTrashEntry> {
  if (!SAFE_ID.test(id)) throw new Error('invalid trash id')
  const dir = path.join(trashDir(), id)
  const entry = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as DesktopTrashEntry
  if (entry.id !== id || entry.restorer !== 'desktop' || !Array.isArray(entry.items)) throw new Error('not a desktop trash entry')
  // 重装过(原处又有插件文件夹):文件会落到 -2 成两份同 id,设置还会盖掉新装那份的 —— 先卸掉新装的再恢复
  const files = entry.items.find((i) => i.role === 'files')
  if (files && await exists(path.join(dir, files.stored)) && await exists(files.from)) throw new Error('plugin-reinstalled')
  for (const it of entry.items) {
    if (!/^items\/\d+$/.test(it.stored)) throw new Error('invalid trash item')
    const st = await fs.lstat(path.join(dir, it.stored)).catch(() => null)
    if (!st) continue
    let target = it.from
    const ext = st.isDirectory() ? '' : path.extname(target), stem = target.slice(0, target.length - ext.length)
    for (let n = 2; await exists(target); n++) target = `${stem}-${n}${ext}`
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (it.parent && await fs.realpath(path.dirname(target)) !== it.parent) throw new Error('restore-target-moved') // 上级被换成软链:别挪到链接指向的地方
    await move(path.join(dir, it.stored), target)
  }
  await fs.rm(dir, { recursive: true, force: true })
  return entry
}
