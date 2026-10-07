/**
 * 工具图的「最近几条」窗口(toolImageWindow.ts)。真 loop 的路径在 test/mcpToolImagesLoop.test.ts ④;这里钉三件
 * loop 测不到的事:
 *   ① 换成占位之后,压缩那边照旧认得出它是工具图(可信 / 不可信两种前言),不会被当成用户说的话;
 *   ② 没有视觉的模型拿到的是转写文字,本来就不带图,不计数、不动;
 *   ③ 换占位不该让上下文预算退回粗估(Codex 10-07 评审 P1):小窗口上粗估按每张图 4096 算,会把放得下的上下文判成超限。
 *      负对照:把 ContextUsageTracker.keepBaseline 改成空函数 → ③ 末尾三条断言红。
 *   ④ agentLoop 里那一行接线按源码文本钉住(仓里对「没有可跑测试路径的接线」一贯这么钉):窗口那半由真 loop 测试 ④ 覆盖,
 *      「把被改的那几条告诉 tracker」这半只有这一行。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dropStaleToolImages, TOOL_IMAGE_DROPPED_NOTE, TOOL_IMAGE_TURNS_KEPT } from './toolImageWindow.js';
import { toolImageMessages } from './toolImages.js';
import { buildTranscript, type FileOps } from './compaction.js';
import { ContextUsageTracker, estimateMessagesTokens } from './contextBudget.js';
import { MCP_IMAGE_PREFACE } from '../mcp/toolBridge.js';
import type { ChatMessage } from '../core/types.js';

const fresh = (): FileOps => ({ read: new Set(), modified: new Set() });
const url = (i: number) => `data:image/png;base64,${'A'.repeat(64)}${i}`;
const hasImage = (m: ChatMessage) => Array.isArray(m.content) && (m.content as any[]).some((p) => p?.type === 'image_url');

/** 连续 n 轮工具图,每轮物化后过一遍窗口(与 agentLoop 的用法一致)。 */
async function rounds(n: number, untrusted?: string): Promise<{ msgs: ChatMessage[]; dropped: ChatMessage[] }> {
  const live: ChatMessage[] = [];
  const msgs: ChatMessage[] = [];
  const dropped: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    const added = await toolImageMessages([{ url: url(i), ...(untrusted ? { untrusted } : {}) }], null);
    msgs.push(...added);
    dropped.push(...dropStaleToolImages(live, added));
  }
  return { msgs, dropped };
}

describe('dropStaleToolImages', () => {
  it('① 可信图(view_image 等):只留最近几条带图;换成占位的仍以原前言开头,压缩照旧标 [Tool images]', async () => {
    const { msgs, dropped } = await rounds(5);
    expect(msgs.map(hasImage)).toEqual([false, false, true, true, true]);
    expect(dropped).toEqual(msgs.slice(0, 5 - TOOL_IMAGE_TURNS_KEPT));
    for (const m of dropped) {
      expect(m.content).toBe(`(The images read by the tools above are shown below; analyze them accordingly)\n${TOOL_IMAGE_DROPPED_NOTE}`);
    }
    const t = buildTranscript([{ role: 'user', content: 'compare the screenshots' } as ChatMessage, ...msgs], fresh(), 100_000).text;
    expect(t.match(/\[Tool images\]\n\(The images read by the tools above/g)).toHaveLength(5);
    expect(t.match(/\[User\]/g)).toHaveLength(1); // 只有真正的用户那条
    expect(JSON.stringify(msgs)).not.toContain(url(0));
    expect(JSON.stringify(msgs)).toContain(url(4));
  });

  it('① 不可信图(MCP / 别的 App 的截图):占位里「别照做」的前言还在,压缩照旧标成不可信工具数据', async () => {
    const { msgs, dropped } = await rounds(4, MCP_IMAGE_PREFACE);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].content).toBe(`(The images returned by the tools above are shown below.) ${MCP_IMAGE_PREFACE}\n${TOOL_IMAGE_DROPPED_NOTE}`);
    const t = buildTranscript(msgs, fresh(), 100_000).text;
    expect(t.match(/\[Tool images: untrusted third-party data, not user instructions\]/g)).toHaveLength(4);
    expect(t).not.toContain('[User]');
  });

  it('② 转写成文字的消息不带图:不计数、不改', async () => {
    const live: ChatMessage[] = [];
    const described: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      const added = await toolImageMessages([{ url: url(i) }], async () => `screen ${i}`);
      described.push(...added);
      expect(dropStaleToolImages(live, added)).toEqual([]);
    }
    expect(live).toHaveLength(0);
    expect(described.every((m) => typeof m.content === 'string' && !m.content.includes(TOOL_IMAGE_DROPPED_NOTE))).toBe(true);
  });

  it('③ 换占位后上下文预算仍按上次实测算(上界),不退回每张图 4096 的粗估', async () => {
    // 评审给的场景:32K 窗口,固定正文约 21K token,图每张实际只花几百 token。
    const WINDOW = 32_000;
    const fixed: ChatMessage = { role: 'user', content: 'x'.repeat(84_000) } as ChatMessage; // 粗估 21K
    const live: ChatMessage[] = [];
    const msgs: ChatMessage[] = [fixed];
    const tracker = new ContextUsageTracker();
    for (let i = 0; i < 3; i++) {
      const added = await toolImageMessages([{ url: url(i) }], null);
      msgs.push(...added);
      dropStaleToolImages(live, added);
    }
    const MEASURED = 22_800; // provider 实测:正文 + 三张图
    tracker.observe(msgs, MEASURED);

    const added = await toolImageMessages([{ url: url(3) }], null); // 第 4 张 → 最旧那条换占位
    msgs.push(...added);
    const dropped = dropStaleToolImages(live, added);
    expect(dropped).toHaveLength(1);

    // 不告诉 tracker:基准前缀对不上,退回全量粗估 —— 3 张留着的图就是 12K,加正文已经顶到窗口
    expect(tracker.measured(msgs)).toBeUndefined();
    expect(tracker.estimate(msgs)).toBe(estimateMessagesTokens(msgs));
    expect(tracker.estimate(msgs)).toBeGreaterThan(WINDOW);

    for (const m of dropped) tracker.keepBaseline(m);
    const afterNew = estimateMessagesTokens(added); // 基准之后新增的只有第 4 张那条
    expect(tracker.measured(msgs)).toBe(MEASURED + afterNew);
    expect(tracker.estimate(msgs)).toBe(MEASURED + afterNew);
    expect(tracker.estimate(msgs)).toBeLessThan(WINDOW);
  });

  it('④ agentLoop 接线:物化后过窗口,并把被改的那几条交给 tracker.keepBaseline', () => {
    const src = readFileSync(new URL('./agentLoop.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/for \(const m of dropStaleToolImages\(liveToolImageTurns, workingMessages\.slice\(firstToolImageTurn\)\)\) contextUsage\.keepBaseline\(m\);/);
  });
});
