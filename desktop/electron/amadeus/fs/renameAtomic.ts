import { promises as fs } from 'node:fs'

/** Windows readers/virus scanners can briefly deny replacement of an open file.
 * Retry the same atomic rename; never unlink the destination or fall back to copy. */
export async function renameAtomic(from: string, to: string, platform: NodeJS.Platform = process.platform, rename = fs.rename, pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))): Promise<void> {
  const delays = [20, 50, 100, 200]
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return }
    catch (error: any) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= delays.length) throw error
      await pause(delays[attempt])
    }
  }
}

/** 写临时文件 → fsync → renameAtomic。不刷盘就 rename,断电 / 死机后可能留下长度还在、字节全是 0x00 的文件(magpie #1505)。
 *  tmp 由调用方给(watcher 按名字认自写临时文件),必须是不存在的唯一名:`wx` 独占创建,名字被占就抛 EEXIST、不碰那个文件。
 *  建出临时文件之后任何一步失败都删掉它、原文件不动。
 *  ponytail: 不 fsync 目录 —— 断电丢的是这次 rename,原位仍是上一份完整的。 */
export async function writeFileDurable(abs: string, tmp: string, data: string | Uint8Array): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined = await fs.open(tmp, 'wx') // 在 try 外:没建成就没有要清的
  try {
    await handle.writeFile(data)
    await handle.sync()
    const closing = handle; handle = undefined; await closing.close() // 先放手再关:close 报错时 catch 里不会再关一次
    await renameAtomic(tmp, abs)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
