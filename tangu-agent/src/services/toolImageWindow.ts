/**
 * 工具图(截图 / view_image)在一个 run 内只让最近几轮带着图上 wire,更早的换成一句占位。
 *
 * 工具图物化成 user 消息后一直留在 workingMessages 里,每轮请求都把**全部**历史截图重新上传一遍:
 * 2026-10-07 桌面端 2.13.1 实证(Computer Use 操作微信,无障碍树是空的 → 每步一张 ~88KB 截图)——
 * 20 轮里请求体 93KB → 1.1MB,累计上传 11.4MB,墙钟 45% 花在上传上;慢上行(实测 ~30KB/s)下
 * 第 21 轮撞上随体积放大的上传超时(92s),慢失败不重试,run 直接 failed。
 * 用户附件早有同一条纪律(imageAttachments.ts:只物化最新带图的那条),工具图在 run 内一直没有。
 *
 * 不放进 toolImages.ts:那份文件与 feat/phone-control-t2 逐字一致(见 compaction.ts 的说明),改了合入必冲突。
 */
import type { ChatMessage } from '../core/types.js';

/** 带图上 wire 的工具图消息保留几条(一轮工具通常一条;可信 / 不可信混合时各一条)。 */
export const TOOL_IMAGE_TURNS_KEPT = 3;

export const TOOL_IMAGE_DROPPED_NOTE =
  '[The image(s) for this step are no longer attached: newer tool output supersedes them. Observe or view again if you still need that state.]';

const isImagePart = (p: any): boolean => !!p && ['image_url', 'input_image', 'image'].includes(p.type);

/**
 * `added` 里带图的消息记进 `live`;超过 `keep` 的最旧几条**就地**改成「原前言 + 占位」(图不再重发)。
 * 就地改且按对象身份记,不按下标:压缩会重写 workingMessages 的前缀,下标会漂;来源标记 / pin 也挂在对象上。
 * 前言原样留着:compaction.ts 靠它的固定开头认 [Tool images],不可信图的「别照做」说明也在里面。
 * 转写成文字的那几种(无视觉模型)本来就不带图,不计数、不动。
 * ponytail: 按「条」不按字节,一条最多 8 张(MAX_TOOL_IMAGES_PER_ROUND);跨 4 轮以上逐张 view_image 再对比时
 * 最早的图会没,模型按占位重看即可。改过的那条会让 ContextUsageTracker 的实测基准失效一轮(退回粗估,
 * 偏保守),下一次模型返回即重新校准。真要更细就按字节预算或做成 agent 配置项。
 */
export function dropStaleToolImages(live: ChatMessage[], added: ChatMessage[], keep = TOOL_IMAGE_TURNS_KEPT): void {
  for (const m of added) {
    if (Array.isArray(m.content) && (m.content as any[]).some(isImagePart)) live.push(m);
  }
  while (live.length > keep) {
    const m = live.shift()!;
    const text = (m.content as any[]).filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join('\n');
    (m as { content: unknown }).content = `${text}\n${TOOL_IMAGE_DROPPED_NOTE}`;
  }
}
