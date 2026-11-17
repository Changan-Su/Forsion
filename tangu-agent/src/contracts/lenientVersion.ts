/** Release-version order of docs/reference/release-versions.md (contracts/releaseVersion.mjs), but lenient: numeric core
 *  (missing parts = 0, leading v ignored), a prerelease sorts below its release, +build.N breaks ties, other metadata ignored:
 *  2.13.8-beta.1 < 2.13.8-beta.2 < 2.13.8 < 2.13.8+build.1. Shared by the desktop host (re-exported from
 *  desktop/shared/amadeus/ipc.ts) and the engine's plugin dependency check. lcl/spaces/userSpaces.core.ts keeps a copy; change both. */
export function cmpVersion(a: string, b: string): number {
  // 数字段按字符串比长度再比字典序:合法 semver 的数字段可以超出 Number 精度
  const numCmp = (x: string, y: string) => {
    const [u, w] = [x.replace(/^0+(?=\d)/, ''), y.replace(/^0+(?=\d)/, '')]
    return u === w ? 0 : u.length !== w.length ? (u.length < w.length ? -1 : 1) : u < w ? -1 : 1
  }
  const parse = (v: string) => {
    const [main, meta = ''] = String(v).trim().replace(/^v/i, '').split(/\+(.*)/s)
    const [core, pre] = main.split(/-(.*)/s)
    // 元数据里只有 +build.N 有序(安装包修订号),其余不参与比较
    const rev = /^build\.(\d+)$/.exec(meta)?.[1] ?? '0'
    return { core: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [], rev }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const d = (pa.core[i] || 0) - (pb.core[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  // 同号:带预发布的排在正式版之前(旧版只认数字段,把 2.13.8-beta.1 当成 2.13.8.1、排到 2.13.8 之上)
  if (!pa.pre.length !== !pb.pre.length) return pa.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1 // 前缀相同,段少的在前
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (numCmp(x, y)) return numCmp(x, y); continue }
    if (nx !== ny) return nx ? -1 : 1 // 纯数字段排在字母段之前
    if (x !== y) return x < y ? -1 : 1
  }
  return numCmp(pa.rev, pb.rev) // 2.13.7 < 2.13.7+build.1 < 2.13.7+build.10
}
