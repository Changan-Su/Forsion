/**
 * 收件箱广播附件的领取条件 —— 本地预判(真闸在服务端 claim 端点,见 server/src/services/claimRequirements.ts)。
 * 版本是定论(跑的就是这一版);会员档位由调用方现拉(authStatus → /brain/users/me,与服务端闸同源),
 * 拉不到就是 null = 不知道 —— 不知道就不拦,交给服务端裁决(绝不拿陈旧档位把刚开会员的人挡在门外)。
 */
import { cmpVersion } from '@amadeus-shared/ipc'
import type { InboxClaimRequirements } from '../../services/backendService'
import type { AuthStatusInfo } from '../../types'

export type ClaimReqKey = 'minVersion' | 'tiers'
const KNOWN = new Set<string>(['minVersion', 'tiers'])

export function unmetClaimRequirements(r: InboxClaimRequirements, ctx: { version: string; tier: string | null | undefined }): ClaimReqKey[] {
  const out: ClaimReqKey[] = []
  if (r.minVersion && cmpVersion(ctx.version, String(r.minVersion)) < 0) out.push('minVersion')
  if (Array.isArray(r.tiers) && r.tiers.length && ctx.tier != null && !r.tiers.includes(ctx.tier)) out.push('tiers')
  return out
}

/** 只认这一次现拉成功的会员档位:authStatus() 每次都现打 whoami,成功才 tokenValid === true;离线时它回的是
 *  缓存资料(tokenValid null),档位可能是开会员之前的旧值 —— 拿它判会把刚付费的人挡在门外,所以当「不知道」。 */
export function tierFromAuth(a: Pick<AuthStatusInfo, 'loggedIn' | 'tokenValid' | 'membershipTier'> | null | undefined): string | null {
  return a?.loggedIn && a.tokenValid === true ? (a.membershipTier ?? null) : null
}

/** 服务端以后加的条件本端不认识:只提示「另有条件」,不预判。 */
export const hasUnknownRequirement = (r: InboxClaimRequirements): boolean => Object.keys(r).some((k) => !KNOWN.has(k))
