/**
 * 托管模型的视觉标注口径。`global_models.supports_vision` 列默认 TRUE —— 建模型时没人会去
 * 取消勾选,所以 TRUE 携带的信息量是零。把它当 override 会让硬编码黑名单在整个托管面失效
 * (2026-08-04 那次「图发给纯文本模型 → 整 run 报废」正是这条链路),故只认 false。
 */
import { describe, it, expect } from 'vitest';
import { visionOverrideOf } from './models.js';
import { modelSupportsVision } from '../llm/modelCapabilities.js';

describe('托管模型 supportsVision 标注', () => {
  it('只有显式 false 算标注,默认 TRUE 不得架空黑名单', () => {
    expect(visionOverrideOf(false)).toBe(false);
    expect(visionOverrideOf(true)).toBeUndefined();
    expect(visionOverrideOf(undefined)).toBeUndefined();
    expect(visionOverrideOf(null)).toBeUndefined();
  });

  it('纯文本模型带着 DB 默认的 TRUE 过来,仍然判为无视觉', () => {
    expect(modelSupportsVision('glm-5.3', visionOverrideOf(true))).toBe(false);
    expect(modelSupportsVision('DeepSeek-V4-Pro', visionOverrideOf(true))).toBe(false);
    // admin 明确取消勾选 → 仍然一票否决(即使表里认为它能看图)
    expect(modelSupportsVision('gpt-5.6', visionOverrideOf(false))).toBe(false);
    // 表里认为能看图 + 没标注 → 放行
    expect(modelSupportsVision('deepseek-v4-flash-vision-exp', visionOverrideOf(true))).toBe(true);
    expect(modelSupportsVision('glm-5.3-flash', visionOverrideOf(true))).toBe(true);
  });
});
