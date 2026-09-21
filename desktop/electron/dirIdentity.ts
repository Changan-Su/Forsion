/**
 * 目录的**身份**(dev + ino),无 Electron 依赖。宿主侧的授权(开发态加载 / 允许从应用外拉起)绑的是它,不是路径字符串:
 *  · 用户给项目文件夹改名、在同一个卷里挪位置 —— inode 不变,授权照旧(「改名不丢快捷方式」这句承诺靠它兑现);
 *  · 同一个产物 id 的 sidecar 被人搬进**另一个**文件夹 —— 那是另一个 inode,授权不跟着走(防冒用照样成立)。
 * 跨卷移动会换 inode:授权失效,重新「添加到桌面」/「在 Forsion 中加载」一次即可(fail closed,不是数据丢失)。
 * ponytail: ino 用 number —— 超过 2^53 的 inode(某些网络 / 虚拟文件系统)会丢精度,两个目录撞身份的概率可忽略;
 *           真碰上再换 bigint(要同时改落盘格式)。
 */
import { statSync } from 'node:fs'

export interface DirIdentity { dev: number; ino: number }

/** 取不到(不存在 / 不是目录 / 没权限)→ null;调用方一律按「不认」处理。 */
export function dirIdentity(dir: string): DirIdentity | null {
  try {
    const st = statSync(dir)
    return st.isDirectory() ? { dev: st.dev, ino: st.ino } : null
  } catch { return null }
}

export function isDirIdentity(value: unknown): value is DirIdentity {
  const v = value as DirIdentity | null
  return !!v && typeof v === 'object' && Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino)
}

/** dir 此刻是不是当初登记的那个目录。 */
export function matchesDirIdentity(dir: string, want: DirIdentity): boolean {
  const now = dirIdentity(dir)
  return !!now && now.dev === want.dev && now.ino === want.ino
}
