/**
 * 拟人分段回复(通道无关 + 按 agent)。任何「按条发消息」的交付通道(微信 / 未来其它 bot 通道)都用本模块:
 * 按 **per-agent 设置(回落全局)** 决定是否把一条回复拆成多段、段间延迟多少;拆分用 splitMessage(纯函数)。
 *
 * 设置面板由 plugins/reply-segment(文件夹插件,scopes: global + agent)声明;真正的分段行为留在核心
 * (与通道解耦),通道只调 resolveReplySegment + splitMessage/segmentDelayMs。
 *
 * 平滑迁移:旧 id `wechat-segment`(全局开关)在新 id 未启用时仍被读取沿用(老微信用户无缝过渡)。
 */
import { isPluginEnabledSync, getPluginSettingsSync } from '../plugins/settingsStore.js';
import { splitMessage, segmentDelayMs } from '../wechat/splitMessage.js';

export const REPLY_SEGMENT_PLUGIN_ID = 'reply-segment';
const LEGACY_PLUGIN_ID = 'wechat-segment'; // 旧「微信分段消息」插件 id(已泛化重命名,read-time 回落以兼容)

export { splitMessage, segmentDelayMs };

export interface ReplySegmentConfig {
  /** 该 agent 是否分段发送。 */
  enabled: boolean;
  /** 段间基础延迟(ms);undefined = 用 segmentDelayMs 的内置默认。 */
  delayBase?: number;
}

const numOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * 解析某 agent 的分段配置。新 id 启用 → 用其设置(支持 per-agent `apply` 覆盖,全局值为默认);
 * 新 id 未启用但旧 wechat-segment 启用 → 沿用旧全局行为(无 per-agent)。两者皆未启用 → 不分段。
 */
export function resolveReplySegment(agentSlug?: string): ReplySegmentConfig {
  if (isPluginEnabledSync(REPLY_SEGMENT_PLUGIN_ID)) {
    const s = getPluginSettingsSync(REPLY_SEGMENT_PLUGIN_ID, agentSlug ? { agentSlug } : undefined);
    return { enabled: s.apply !== false, delayBase: numOr(s.segmentDelayMs) }; // apply 默认开;某 agent 显式关 → false
  }
  if (isPluginEnabledSync(LEGACY_PLUGIN_ID)) {
    // 旧插件 meta 已不注册,但 config 里的 segmentDelayMs 仍可读;旧版本无 per-agent 概念,恒分段。
    return { enabled: true, delayBase: numOr(getPluginSettingsSync(LEGACY_PLUGIN_ID).segmentDelayMs) };
  }
  return { enabled: false };
}
