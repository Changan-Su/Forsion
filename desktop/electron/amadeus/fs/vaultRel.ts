import path from 'node:path'

/** 库内相对路径的统一写法:`/` 分隔(2026-10-19)。渲染层、共享代码(链接解析、引用改写、.fd 级联)和主进程挪动 / 改名
 *  的回传全按 `/` 写,唯独 Windows 上 path.relative 给 `\` —— listPages 原样交出去,树里的行、开着的标签、索引键就和
 *  挪动 / 改名之后的路径成了同一篇的两种写法,按字面比处处认不出(PR #64 Windows 红在「拖回」那步)。
 *  所有交出去的库内路径、所有拿来当键的库内路径都过它。POSIX 上原样:那里 `\` 是合法的文件名字符,不能换。 */
export const vaultRel = (p: string, sep: string = path.sep): string => (sep === '/' ? p : p.split(sep).join('/'))
