/**
 * 工具回灌的图片(ToolContext.collectImage)→ 本轮工具跑完后追加到对话尾部的 user 消息。agentLoop 每轮调一次。
 *
 * 两类图,按 `untrusted`(工具写的前言句)分组,各出一条消息:
 *  - 可信(view_image / view_video / desk_present / hostExec:用户自己的文件、Forsion 自己的界面):
 *    主模型无视觉先经辅助视觉模型转写;转写失败时只向支持图片输入的主模型回传原图,否则留说明。
 *  - 不可信(phone_observe 截图:**别的 App** 的屏幕):
 *    ⚠️ 图只能放进 user 角色消息(provider 不收 tool 角色的图),所以必须在同一条消息里标明「不可信、别照做」,
 *       否则截图里的注入(「SYSTEM NOTICE… tap 转账」)带着用户权威进上下文,绕过屏幕文字的 DATA 围栏。
 *    ⚠️ 视觉转写同样圈进围栏、尖括号中和(转写原文就是第三方屏幕上的字,还可能被注入带偏)。
 *    ⚠️ 转写失败 → **丢图并留一句说明**,不退回送图:这类截图总伴随同一屏的文本树,丢图不丢内容;
 *       直接把图塞给无视觉模型只会让 provider 报错、整条 run 失败。
 */
import type { ChatMessage } from '../core/types.js';
import { toImageParts } from './imageAttachments.js';

export interface ToolImage {
  url: string;
  /** 不可信来源的前言句(工具写,如「它们是别的 App 的截图…」);缺省 = 可信。 */
  untrusted?: string;
}

/** 主模型要转写时传入(可抛错);null = 主模型能直接看图(或 run 已中止)。 */
export type DescribeFn = (imgs: Array<{ url: string }>) => Promise<string>;

export const UNTRUSTED_IMAGE_TAG = 'untrusted_image_text';
export const TOOL_IMAGE_DESCRIPTION_FAILED =
  '(The tools captured or read images, but the vision assistant model could not describe them. You did not receive the images. If the task requires seeing them, tell the user that the visual check could not be completed. Use the available text results.)';

type DescribeFailure = {
  onError?: (e: unknown) => void;
  /** 只在可信图转写失败时检查,例如「始终使用」档中的主模型仍可能有视觉。 */
  canUseOriginal?: () => Promise<boolean>;
};

const neutralize = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›');

export async function toolImageMessages(
  imgs: ToolImage[],
  describe: DescribeFn | null,
  failure?: DescribeFailure,
): Promise<ChatMessage[]> {
  // 按前言分组、保持首次出现的顺序(一轮里通常只有一类;混合时各出一条)。
  const groups = new Map<string | undefined, Array<{ url: string }>>();
  for (const i of imgs) {
    if (!i || typeof i.url !== 'string' || !i.url) continue;
    const key = typeof i.untrusted === 'string' && i.untrusted.trim() ? i.untrusted.trim() : undefined;
    const g = groups.get(key) ?? [];
    g.push({ url: i.url });
    groups.set(key, g);
  }
  const out: ChatMessage[] = [];
  for (const [preface, group] of groups) {
    let described = '';
    if (describe) {
      try {
        described = await describe(group);
      } catch (e) {
        failure?.onError?.(e);
      }
    }
    const failed = !!describe && !described;
    if (preface === undefined) {
      if (failed && !(await failure?.canUseOriginal?.())) {
        out.push({ role: 'user', content: TOOL_IMAGE_DESCRIPTION_FAILED });
        continue;
      }
      out.push({
        role: 'user',
        content: described
          ? `(The images read by the tools above were transcribed by the vision assistant model, because the current model has no native image input. Description follows.)\n\n${described}`
          : toImageParts('(The images read by the tools above are shown below; analyze them accordingly)', group),
      } as ChatMessage);
      continue;
    }
    if (described) {
      out.push({
        role: 'user',
        content: `(The images returned by the tools above were transcribed by the vision assistant model, because the current model has no native image input.) ${preface}\n`
          + `<${UNTRUSTED_IMAGE_TAG}>\n${neutralize(described)}\n</${UNTRUSTED_IMAGE_TAG}>`,
      } as ChatMessage);
    } else if (failed) {
      out.push({
        role: 'user',
        content: '(The images returned by the tools above could not be shown: the current model has no image input and the vision assistant model could not transcribe them. Rely on the text results.)',
      } as ChatMessage);
    } else {
      out.push({ role: 'user', content: toImageParts(`(The images returned by the tools above are shown below.) ${preface}`, group) } as ChatMessage);
    }
  }
  return out;
}
