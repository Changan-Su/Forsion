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
    // 198.18.0.0/15(基准测试段)刻意不拦:Clash / Surge / Mihomo 的 TUN + fake-IP 把所有域名解析到这一段,
    // 拦了开发机上所有抓取(书签预览、日历订阅、ctx.net)都会断(10-26 upstream-watch D12 / 11-14 日志已定)。
    if (a === 198 && b === 51 && p[2] === 100) return true // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && p[2] === 113) return true // 203.0.113.0/24 TEST-NET-3
    if (a === 192 && b === 88 && p[2] === 99) return true // 192.88.99.0/24 6to4 中继任播(已废弃)
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
    // 其余一律只放全球单播 2000::/3(今天所有公网 IPv6 都在里面):链路本地 fe80::/10、唯一本地 fc00::/7、组播 ff00::/8、
    // 已废弃的站点本地 fec0::/10、本地用 NAT64 64:ff9b:1::/48、丢弃前缀 100::/64 …… 都在它外面(2026-11-16 Codex 评审:逐段列黑名单总会漏)
    if ((w[0] & 0xe000) !== 0x2000) return true
    if (w[0] === 0x2001 && w[1] === 0) return true // 2001::/32 Teredo(内嵌的 v4 被混淆过,判不了)
    if (w[0] === 0x2001 && w[1] === 0x2 && w[2] === 0) return true // 2001:2::/48 基准测试
    if (w[0] === 0x2001 && (w[1] & 0xfff0) === 0x0020) return true // 2001:20::/28 ORCHIDv2
    if (w[0] === 0x2001 && (w[1] & 0xfff0) === 0x0010) return true // 2001:10::/28 ORCHID(已废弃)
    if (w[0] === 0x2001 && w[1] === 0x0db8) return true // 2001:db8::/32 文档段
    if (w[0] === 0x3fff) return true // 3fff::/20 文档段(RFC 9637;按 /16 拦,宽一点无妨)
    if (w[0] === 0x2002) return isPrivateIp(`${w[1] >> 8}.${w[1] & 0xff}.${w[2] >> 8}.${w[2] & 0xff}`) // 2002::/16 6to4:按内嵌 v4 判
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
