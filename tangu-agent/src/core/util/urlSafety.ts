/**
 * SSRF 防护(vendored,C 类纯函数;原 server/microserver/ai-studio/services/urlSafety.ts)。
 * 把任意 URL 解析为「确认指向公网」的 URL,杜绝打内网/回环/云元数据。
 * 仅 http/https;拒绝 localhost;DNS 解析所有 A/AAAA 记录,任一落在私有/保留段即拒。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF 协议保留
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1/2/3(文档保留段,不该路由)
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 基准测试保留
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 中继任播
    a >= 224
  );
}

/** IPv6 文本 → 16 字节;非法返回 null。**必须按字节判**:文本前缀匹配会被未压缩形式
 *  ('0:0:0:0:0:0:0:1'、'0:0:0:0:0:ffff:7f00:1')逃逸 —— 那是 fail-open。 */
function ipv6Bytes(address: string): number[] | null {
  let s = address.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // 尾部内嵌 IPv4('::ffff:127.0.0.1')→ 先换成两个 0 hextet 占位,最后回填字节
  let v4: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const parts = s.slice(lastColon + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    v4 = parts;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (seg: string): number[] | null => {
    if (!seg) return [];
    const out: number[] = [];
    for (const g of seg.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  const total = head.length + tail.length;
  if (halves.length === 2 ? total > 7 : total !== 8) return null;
  const groups = [...head, ...Array<number>(8 - total).fill(0), ...tail];
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}

function isPrivateIpv6(address: string): boolean {
  const b = ipv6Bytes(address);
  if (!b) return true; // 解析不了按危险处理
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`); // v4-mapped
  }
  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  const first = (b[0]! << 8) | b[1]!;
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // 链路本地 / 废弃站点本地
  if (b[0] === 0xff) return true; // ff00::/8 组播
  if (first === 0x100 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64 黑洞(精确 /64)
  if (first === 0x2001 && ((b[2]! << 8) | b[3]!) === 0x0db8) return true; // 2001:db8::/32 文档保留
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const ipType = net.isIP(address);
  if (ipType === 4) return isPrivateIpv4(address);
  if (ipType === 6) return isPrivateIpv6(address);
  return true;
}

/** 解析并校验 URL 指向公网;通过则返回 URL + 校验时解析到的地址。调用方在连接层钉住这些
 *  地址(node http/https 的 lookup 钩子)即可关死 DNS rebinding(校验/连接两次解析被换答案)。 */
export async function resolvePublicHttpUrl(rawUrl: string): Promise<{ url: URL; addresses: string[] }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }

  // IPv6 字面量在 URL.hostname 里带方括号('[::1]')—— 剥掉再判,否则会被当域名送去 DNS
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed');
  }

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('Private or reserved IP addresses are not allowed');
    return { url: parsed, addresses: [hostname] };
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('URL hostname could not be resolved');
  if (records.some((record) => isBlockedAddress(record.address))) {
    throw new Error('Private or reserved IP addresses are not allowed');
  }

  return { url: parsed, addresses: records.map((r) => r.address) };
}

/** 解析并校验 URL 指向公网;通过则返回 URL 对象,否则抛错。 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicHttpUrl(rawUrl)).url;
}
