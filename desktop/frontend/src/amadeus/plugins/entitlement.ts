/** `ctx.account.entitlements()`: does the signed-in account hold what this plugin declares in manifest `requires`.
 *  null means unknown (offline, signed out, an old server, an unreadable reply) and must never read as false: the UI
 *  uses this to pick an onboarding page, and telling someone they lack access because of a dropped connection is the
 *  failure to avoid. The real gate is server-side. */
export async function readEntitlement(
  request: (path: string) => Promise<Response>,
  name: string | undefined,
): Promise<{ granted: boolean | null }> {
  if (!name) return { granted: true }
  try {
    const response = await request('/org/entitlements')
    if (!response.ok) { await response.body?.cancel(); return { granted: null } }
    const list = ((await response.json()) as { entitlements?: unknown } | null)?.entitlements
    return { granted: Array.isArray(list) ? list.includes(name) : null }
  } catch { return { granted: null } }
}
