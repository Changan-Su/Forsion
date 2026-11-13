/** Account menu points are independent from AI quota. Only public view data crosses this seam. */
export interface AccountRewards {
  balance: number | null
  balanceFailed: boolean
  invite: 'available' | 'hidden' | 'unknown'
}
export const ACCOUNT_REWARDS_CHANGED = 'forsion:account-rewards-changed'
export const emptyAccountRewards = (): AccountRewards => ({ balance: null, balanceFailed: false, invite: 'unknown' })

export async function loadAccountRewards(): Promise<AccountRewards> {
  const fetch = window.tangu?.cloudFetch
  const visitorRewards = window.tangu?.accountRewards
  if (!visitorRewards && !fetch) return { balance: null, balanceFailed: true, invite: 'unknown' }
  // Official Unit Web has fixed account reads, while desktop keeps its cloud transport.
  const [balance, invite] = visitorRewards
    ? await visitorRewards().then((result) => [
      { status: 'fulfilled', value: result.balance } as const,
      { status: 'fulfilled', value: result.invite } as const,
    ]).catch(() => [
      { status: 'rejected' } as const, { status: 'rejected' } as const,
    ])
    : await Promise.allSettled([
      fetch!({ path: '/credits/balance', timeoutMs: 6000 }),
      fetch!({ path: '/invite/my-code', timeoutMs: 6000 }),
    ])
  const value = balance.status === 'fulfilled' && balance.value.status === 200 ? balance.value.json?.balance : null
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
  return {
    balance: Number.isFinite(n) ? n : null,
    balanceFailed: !Number.isFinite(n),
    invite: invite.status === 'fulfilled' && invite.value.status === 404 ? 'hidden'
      : invite.status === 'fulfilled' && invite.value.status === 200 ? 'available' : 'unknown',
  }
}
