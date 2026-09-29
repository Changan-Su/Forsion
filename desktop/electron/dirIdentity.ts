/**
 * 目录的**身份**(dev + ino + 创建时间),无 Electron 依赖。宿主侧的授权(开发态加载 / 允许从应用外拉起)绑的是它,不是路径字符串:
 *  · 用户给项目文件夹改名、在同一个卷里挪位置 —— inode 与创建时间都不变,授权照旧(「改名不丢快捷方式」这句承诺靠它兑现);
 *  · 同一个产物 id 的 sidecar 被人搬进**另一个**文件夹 —— 那是另一个 inode,授权不跟着走(防冒用照样成立);
 *  · 同一路径删掉重建 —— Linux(ext4 等)常会复用刚释放的 inode,只比 dev/ino 会让新目录继承旧授权(同 tangu-agent gitTrust 的修法,
 *    Genesis b0096158),所以再绑创建时间(birthtimeMs)。
 * 跨卷移动会换 inode:授权失效,重新「添加到桌面」/「在 Forsion 中加载」一次即可(fail closed,不是数据丢失)。
 * **没记创建时间的旧记录(2.11.3 / 2.11.4 写的)一律不认**:无从分辨它登记之后目录有没有被重建过。
 * 宿主在认不出时给出重新授权的提示(快捷方式:toast;开发态加载:Sandbox 面板里一行),不静默失败。
 * ponytail: ino 用 number —— 超过 2^53 的 inode(某些网络 / 虚拟文件系统)会丢精度,两个目录撞身份的概率可忽略;
 *           真碰上再换 bigint(要同时改落盘格式)。
 * ponytail: 文件系统不支持创建时间时 Node 回 0(新内核的 statx)或 ctime(不支持 statx 的老内核)。回 0 就退化成只比 dev/ino;
 *           回 ctime 时目录里增删文件就会让授权失效、再授权一次 —— 只会多问,不会误认。不用 productsRegistry 的 birthOf(它回落 ctime)。
 */
import { statSync } from 'node:fs'

export interface DirIdentity { dev: number; ino: number; birth?: number }

/** 取不到(不存在 / 不是目录 / 没权限)→ null;调用方一律按「不认」处理。 */
export function dirIdentity(dir: string): DirIdentity | null {
  try {
    const st = statSync(dir)
    return st.isDirectory() ? { dev: st.dev, ino: st.ino, birth: st.birthtimeMs } : null
  } catch { return null }
}

/** 落盘记录的形状校验。birth 可缺(旧记录照样读得出来 —— 留着它才能认出「这条要重新授权」),缺了在比对时不认。 */
export function isDirIdentity(value: unknown): value is DirIdentity {
  const v = value as DirIdentity | null
  return !!v && typeof v === 'object' && Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino)
    && (v.birth === undefined || Number.isFinite(v.birth))
}

/** 同一个目录:dev、ino、创建时间都对上;任一边没有创建时间(旧记录)→ 不认。 */
export function sameDirIdentity(a: DirIdentity | null | undefined, b: DirIdentity | null | undefined): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && typeof a.birth === 'number' && a.birth === b.birth
}

/** 只比 dev/ino:用来**替换 / 删除**旧登记(宽一点无害),绝不用来放行。 */
export function sameDevIno(a: DirIdentity, b: DirIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** dir 此刻是不是当初登记的那个目录。 */
export function matchesDirIdentity(dir: string, want: DirIdentity): boolean {
  return sameDirIdentity(want, dirIdentity(dir))
}
