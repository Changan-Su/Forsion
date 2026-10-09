// 自写账本(VaultManager.lastWritten)× 监听器(VaultWatcher.handle):哪些文件事件算「外部改动」。
// 真监听不启动 —— 一次文件事件 = 直接调一次 handle() 并等它处理完,不依赖系统的事件什么时候到。
// 负对照(实跑过):不作废旧账 → 第一条红;「对不上就删」或把取账挪到读盘之后 → 第二条红;
// 读回来的内容对得上读盘前那笔账就不报 → 第三条红。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VaultManager } from './vaultManager'
import { VaultWatcher } from './watcher'

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-ledger-'))
  const vault = new VaultManager()
  vault.setRoot(root)
  const reported: string[] = []
  const watcher = new VaultWatcher(vault, (page) => reported.push(page), () => {})
  const abs = path.join(root, 'Note.md')
  return { vault, reported, abs, fileEvent: (): Promise<void> => watcher['handle'](abs, root) }
}

/** 让下一次读盘真的读完(`read` 给出它读到的内容),但卡着不返回;`release()` 之后才把那份已经过时的内容交回去。 */
function holdNextRead() {
  const realRead = fs.readFile.bind(fs)
  let release!: () => void
  let captured!: (content: string) => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const read = new Promise<string>((resolve) => { captured = resolve })
  vi.spyOn(fs, 'readFile').mockImplementationOnce((async (file: string) => {
    const stale = await realRead(file, 'utf8')
    captured(stale)
    await gate
    return stale
  }) as never)
  return { read, release }
}

afterEach(() => { vi.restoreAllMocks() })

describe('自写账本 × 监听器:什么算外部改动', () => {
  it('自己写的不报;别人改了报;别人再原样改回,还是报', async () => {
    const { vault, reported, abs, fileEvent } = await setup()
    await vault.writeTextFile('Note.md', 'A')
    await fileEvent()
    await fileEvent() // 一次写常常不止来一个事件:对得上的账要留着
    expect(reported).toEqual([])
    await fs.writeFile(abs, 'B')
    await fileEvent()
    expect(reported).toEqual(['Note.md'])
    // 盘上又是 A 了,但这个 A 不是我们写的:订阅方手里是 B,这次不报它们就停在 B 上。
    await fs.writeFile(abs, 'A')
    await fileEvent()
    expect(reported).toEqual(['Note.md', 'Note.md'])
  })

  it('读盘途中自己又写了一次:迟回来的那份(别人的)内容不许把新账删掉', async () => {
    const { vault, reported, abs, fileEvent } = await setup()
    await vault.writeTextFile('Note.md', 'A')
    await fs.writeFile(abs, 'X')
    const held = holdNextRead()
    const staleEvent = fileEvent()
    expect(await held.read).toBe('X') // 这次事件已经读到别人的 X,卡着没回来 ——
    await vault.writeTextFile('Note.md', 'B') // —— 期间我们自己把它写成了 B
    held.release()
    await staleEvent
    expect(reported).toEqual(['Note.md']) // X 是别人的,照报
    await fileEvent() // B 自己的回声:账还在,不报
    expect(reported).toEqual(['Note.md'])
  })

  it('读盘途中账变了、迟回来的是我们早先写的那份:照报 —— 它可能是别人那次改动的唯一通知', async () => {
    const { vault, reported, abs, fileEvent } = await setup()
    await vault.writeTextFile('Note.md', 'A')
    const held = holdNextRead()
    const staleEvent = fileEvent()
    expect(await held.read).toBe('A') // 这次事件读到我们自己的 A,卡着没回来 ——
    await vault.writeTextFile('Note.md', 'B') // —— 期间我们又写成 B,
    await fs.writeFile(abs, 'X') // 别人紧跟着改成 X;这两次的事件挨得太近,被监听库丢掉了(没有别的 handle 会来)
    held.release()
    await staleEvent
    expect(reported).toEqual(['Note.md'])
  })
})
