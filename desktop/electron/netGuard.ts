/**
 * 「渲染层给地址、主进程去请求」这类通道的目标校验(SSRF 闸)。纯逻辑与 DNS 分开,前者可单测。
 *
 * 为什么不能只看 URL 字符串:`http://127.0.0.1:8080/` 是本机服务、`169.254.169.254` 是云元数据端点、
 * 攻击者控制的公网域名可以把 A 记录指到 `10.0.0.5`。**必须解析成 IP 再判**,而且重定向的每一跳都要重判。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 回环 / 私网 / 链路本地 / 保留段 → true(即「不许主进程去请求」)。 */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true // 畸形 → 保守拒绝
    const [a, b] = p
    if (a === 0 || a === 10 || a === 127) return true // 本网 / 私网 A / 回环
    if (a === 169 && b === 254) return true // 链路本地(含 169.254.169.254 云元数据)
    if (a === 172 && b >= 16 && b <= 31) return true // 私网 B
    if (a === 192 && b === 168) return true // 私网 C
    if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF 保留 + 192.0.2.0/24 文档段
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
    if (a >= 224) return true // 组播 224/4 + 保留 240/4(含 255.255.255.255)
    return false
  }
  if (v === 6) {
    // 必须展开成 8 个 16 位字再判:URL 会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1,
    // 任何按字符串前缀/点分形匹配的判法都会被十六进制形绕过(2026-08-06 Codex 评审实测)。
    const w = v6Words(ip.toLowerCase().replace(/^\[|\]$/g, ''))
    if (!w) return true // 解析失败 → 保守拒绝
    const v4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0) {
      if (w[5] === 0xffff) return isPrivateIp(v4) // ::ffff:0:0/96 IPv4 映射(点分或十六进制形)
      if (w[5] === 0) {
        if (w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true // :: 未指定 / ::1 回环
        return isPrivateIp(v4) // ::x.y.z.w v4-compatible(废弃形态,按内嵌 v4 判)
      }
    }
    if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) return isPrivateIp(v4) // NAT64 64:ff9b::/96
    if ((w[0] & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
    if ((w[0] & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
    if ((w[0] & 0xff00) === 0xff00) return true // ff00::/8 组播
    return false
  }
  return true // 不是合法 IP → 保守拒绝
}

/** IPv6 字符串 → 8 个 16 位字;非法回 null(isIP 已验过格式,这里只做展开)。 */
function v6Words(s: string): number[] | null {
  const v4tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4tail) {
    const p = v4tail[2].split('.').map(Number)
    if (p.length !== 4 || p.some((n) => n > 255)) return null
    s = v4tail[1] + (((p[0] << 8) | p[1]).toString(16)) + ':' + (((p[2] << 8) | p[3]).toString(16))
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null
  const parts = [...head, ...Array(fill).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const words = parts.map((x) => Number.parseInt(x || '0', 16))
  return words.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : words
}

/**
 * 主机名是否可以放行;不可放行时回一句给用户看的原因,可以放行回 null。
 * 解析失败也回原因 —— 拿不准就不发请求。
 */
export async function privateHostReason(hostname: string): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (!host) return '地址无效'
  if (isIP(host)) return isPrivateIp(host) ? '不允许订阅本机 / 内网地址' : null
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) return '不允许订阅本机 / 内网地址'
  try {
    const all = await lookup(host, { all: true })
    if (!all.length) return '域名解析失败'
    if (all.some((a) => isPrivateIp(a.address))) return '该域名解析到本机 / 内网地址,已拒绝'
    return null
  } catch {
    return '域名解析失败'
  }
}
