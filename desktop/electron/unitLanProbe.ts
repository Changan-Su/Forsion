/**
 * LAN 直连探针(units:probeLan 的本体;主进程发,渲染层跨源 fetch 会被 CORS 拦)。拉对方的 /unit/meta,1.2s 封顶。
 *
 * 回包带上对方报的身份,判「是不是名册里那一行」由渲染层做(unitPanelModel.lanProbeMatches):
 * - unitId:对方在账号设备名册里的 id(新版才报,取不到也不报)。同一台电脑以前登记过的旧记录,直连地址都一样
 *   (同一个局域网 IP + 固定端口),只看「通不通」会把它们全画成可直连 —— 要拿这个 id 对上那一行。
 * - self:应答的就是本机这份 Forsion(安装实例 id 相同)。直连自己没有意义,名册里任何一行都不算。
 * 身份核对只防「旧记录 / 同机别的实例被认成这一行」;陌生设备冒充靠配对流的 6 位码人工比对把关(防 DHCP 换主)。
 */
export interface UnitLanProbeResult {
  instanceId: string
  name: string
  /** 对方报的名册 id;没有这个键 = 对方没报(旧版本,或它此刻不知道自己是名册里哪一行)。 */
  unitId?: string
  /** 应答的是本机自己。 */
  self?: true
}

export async function probeUnitLan(
  lanUrl: string,
  opts: { selfInstanceId?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<UnitLanProbeResult | null> {
  try {
    const u = new URL(String(lanUrl))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1200)
    try {
      const r = await (opts.fetch ?? fetch)(new URL('/unit/meta', u), { signal: ctrl.signal })
      if (!r.ok) return null
      const meta = (await r.json()) as { instanceId?: unknown; name?: unknown; unitId?: unknown } | null
      if (typeof meta?.instanceId !== 'string') return null
      return {
        instanceId: meta.instanceId,
        name: String(meta.name || ''),
        ...(typeof meta.unitId === 'string' && meta.unitId ? { unitId: meta.unitId } : {}),
        ...(opts.selfInstanceId && meta.instanceId === opts.selfInstanceId ? { self: true as const } : {}),
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}
