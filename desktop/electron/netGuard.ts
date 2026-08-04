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
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (s === '::' || s === '::1') return true // 未指定 / 回环
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true // fe80::/10 链路本地
    if (/^f[cd]/.test(s)) return true // fc00::/7 唯一本地
    if (s.startsWith('ff')) return true // 组播
    // IPv4 映射(::ffff:127.0.0.1)按其 v4 部分判
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (m) return isPrivateIp(m[1])
    return false
  }
  return true // 不是合法 IP → 保守拒绝
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
