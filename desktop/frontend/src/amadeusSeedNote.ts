/** 随应用附带的示范笔记(教程 / 使用手册)的落盘口。
 *
 *  语义恒为「**有则不动,无则生成**」—— 生成到用户自己的 vault 里而不是做成只读页面,是因为
 *  这些笔记讲的每一件事都要能当场上手改;而用户改过之后,那就是他的笔记了,绝不覆盖。
 *
 *  ⚠️「不存在」必须**两个独立信号都说不存在**才算数(Codex 08-31 high):readTextFile 的 null
 *     既是「没有这个文件」也是「这次读失败」,只认它的话一次读失败就把用户改过的笔记整篇覆盖 ——
 *     而 writeTextFile 是原子 rename,覆盖即永久。名册(listPages)取不到时一律保守当「已存在」。
 *  ponytail: 真解是主进程开一条 O_EXCL 的「不存在才建」IPC(check-then-write 本身不原子);
 *     为两篇示范笔记开 IPC(preload + ipc + unitWeb 白名单 + 类型)不值,两信号已把窗口收到极小。
 */
import { amadeus } from '@amadeus/api'

/** 写入一篇不存在的示范笔记;已存在则原样保留。返回 true = 这次真写了盘。
 *  抛错由调用方接(两处都要出声:命令面板点一下什么都不发生是本仓反复栽的那种「静默失败」)。 */
export async function seedNoteIfAbsent(path: string, source: string): Promise<boolean> {
  const listed = await amadeus.listPages().catch(() => [path])
  const exists = listed.includes(path) || (await amadeus.readTextFile(path)) != null
  if (exists) return false
  await amadeus.writeTextFile(path, source, { create: true })
  return true
}
