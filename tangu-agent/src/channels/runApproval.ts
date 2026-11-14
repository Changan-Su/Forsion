/**
 * 通道 run 的审批档里「Agent 自己的档」那一层(纯函数,无 I/O)。
 *
 * 通道 run 的生效档 = 通道设置、绑定、Agent 自己的档(设了才算)三者里最严的那个(readonly < auto-edit < full-auto)。
 * 前两者在 service.channelRunApprovalMode 里合;建 run 时身份还没定(会话钉 slug、分身解析都在 agentLoop 里),
 * 所以第三层由 agentLoop 在 Agent 激活之后调 tightenChannelApprovalForAgent 收紧,/approval /status 用同一个函数报。
 *
 * - 只收紧不放宽:Agent 比通道松 → 仍按通道。
 * - Agent 没设(''/缺席)→ 原值原样返回(连归一都不做,和没有这一层时逐字节一样)。
 * - Agent 设的是 custom / 不认识的值 → 按 readonly 算:通道里没人在场逐条审自定义规则(与通道阶梯对绑定 custom 的处理同口径)。
 */
import { normalizeApprovalMode, type ApprovalMode as EngineApprovalMode } from '../services/approvals.js';
import { minCapMode, type CapMode } from '../services/remoteOrigin.js';

/** 通道三档阶梯:custom / 不认识 / 缺席 一律按 readonly(通道设置只提供三档)。 */
export function channelApprovalLadder(m: EngineApprovalMode | undefined): CapMode {
  return m === 'auto-edit' || m === 'full-auto' ? m : 'readonly';
}

/** Agent 定义里的档当上限用:没设 → undefined(不参与);custom / 不认识 → readonly。 */
export function agentApprovalCeiling(raw: unknown): CapMode | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return channelApprovalLadder(normalizeApprovalMode(raw, 'agent definition'));
}

/**
 * 通道档(已合过设置与绑定)再按 Agent 自己的档收紧。agentModes:这次 run 的 Agent 定义档;分身再加上本体的档
 * (分身面对的是别人,不该比本体松;本体读不到由调用方传 'readonly')。全都没设 → 原样返回 channelMode。
 */
export function tightenChannelApprovalForAgent<T>(channelMode: T, agentModes: readonly unknown[]): T | CapMode {
  let cap: CapMode | undefined;
  for (const m of agentModes) cap = minCapMode(cap, agentApprovalCeiling(m));
  if (!cap) return channelMode;
  return minCapMode(channelApprovalLadder(normalizeApprovalMode(channelMode, 'channel run')), cap)!;
}
