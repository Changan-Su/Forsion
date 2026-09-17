import { describe, it, expect } from 'vitest';
import {
  extractFileOps, formatFileOps, parseFileOps, compactionRange, buildTranscript, rowCoverage,
  summaryMessage, isSummaryMessage, compactSystemPrompt, type FileOps,
} from './compaction.js';
import { estimateMessageTokens } from './contextBudget.js';
import type { ChatMessage } from '../core/types.js';

function mk(role: string, content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

describe('compactionRange — 按 token 预算切(借 pi findCutPoint),批次绝不拆', () => {
  it('从最新往回累计到 keepRecentTokens,其后最近的非 tool 消息为切点;开头 system 块不进范围', () => {
    const msgs: ChatMessage[] = [
      mk('system', 'sys'),
      ...Array.from({ length: 20 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i} ` + 'x'.repeat(80))),
    ];
    const perMsg = estimateMessageTokens(msgs[1]);
    const r = compactionRange(msgs, perMsg * 4)!;
    expect(r.head).toBe(1);
    // 保留最后 4 条(累计恰好 ≥ 预算处)→ 切点 = 倒数第 4 条
    expect(r.cut).toBe(msgs.length - 4);
    expect(msgs.slice(r.cut).map((m) => String(m.content).slice(0, 3))).toEqual(['m16', 'm17', 'm18', 'm19']);
  });

  it('切点落在 tool 结果批次里 → 前移到批次后的下一条非 tool 消息(整批进摘要)', () => {
    const msgs: ChatMessage[] = [
      mk('system', 's'),
      ...Array.from({ length: 6 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`)),
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }, { id: 't2' }] } as any,
      { role: 'tool', content: 'r1 ' + 'x'.repeat(400), tool_call_id: 't1' } as any,
      { role: 'tool', content: 'r2 ' + 'x'.repeat(400), tool_call_id: 't2' } as any,
      mk('assistant', 'after batch'),
      mk('user', 'next question'),
    ];
    const tail2 = estimateMessageTokens(msgs[msgs.length - 1]) + estimateMessageTokens(msgs[msgs.length - 2]);
    const r = compactionRange(msgs, tail2 + 1)!; // 名义切点会落在 r2 上
    expect((msgs[r.cut] as any).role).toBe('assistant');
    expect(msgs[r.cut].content).toBe('after batch');
    expect(msgs.slice(r.head, r.cut).filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('对话以一批工具结果收尾(run 内最常见)→ 退到发起这批调用的 assistant,整批原样保留', () => {
    const msgs: ChatMessage[] = [
      mk('system', 's'),
      ...Array.from({ length: 6 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`)),
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'a' }, { id: 'b' }] } as any,
      { role: 'tool', content: 'a result', tool_call_id: 'a' } as any,
      { role: 'tool', content: 'b result', tool_call_id: 'b' } as any,
    ];
    const r = compactionRange(msgs, 5)!; // 预算小到最后一条 tool 就够
    expect(msgs[r.cut].content).toBe('calling');
    expect(msgs.slice(r.cut).map((m: any) => m.tool_call_id)).toEqual([undefined, 'a', 'b']);
  });

  it('全部都在保留预算内 / 只有摘要 / 太短 → null', () => {
    const short: ChatMessage[] = [mk('system', 's'), mk('user', 'a'), mk('assistant', 'b')];
    expect(compactionRange(short, 20_000)).toBeNull();
    expect(compactionRange([mk('system', 's'), summaryMessage('prev'), mk('user', 'a')], 0)).toBeNull();
    expect(compactionRange([mk('system', 's')], 0)).toBeNull();
  });

  it('上一份摘要在范围内(增量更新),head 仍只跳过注入的 system 块', () => {
    const msgs: ChatMessage[] = [
      mk('system', 'sys'), summaryMessage('prev'),
      ...Array.from({ length: 10 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i} ` + 'x'.repeat(40))),
    ];
    const r = compactionRange(msgs, estimateMessageTokens(msgs[2]) * 2)!;
    expect(r.head).toBe(1);
    expect(isSummaryMessage(msgs[r.head])).toBe(true);
    expect(r.cut).toBe(msgs.length - 2);
  });
});

describe('buildTranscript — pi 式行格式;[Existing Summary] 永不被截,超预算从最旧丢并留标记', () => {
  const fresh = (): FileOps => ({ read: new Set(), modified: new Set() });

  it('user / assistant / tool calls / tool result 各有标签;结果只留头尾;上一摘要剥掉头与文件块后进 [Existing Summary]', () => {
    const ops = fresh();
    const msgs: ChatMessage[] = [
      summaryMessage('PREV-GOAL keep-me' + formatFileOps({ read: new Set(['old.ts']), modified: new Set() })),
      mk('user', 'ORIGINAL_GOAL'),
      { role: 'assistant', content: 'Changing', tool_calls: [{ id: 'e1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/p.ts","old_string":"a","new_string":"b"}' } }] } as any,
      { role: 'tool', tool_call_id: 'e1', content: 'HEAD-' + 'x'.repeat(10_000) + '-TAIL' } as any,
    ];
    const t = buildTranscript(msgs, ops, 100_000);
    expect(t.incremental).toBe(true);
    expect(t.text.startsWith('[Existing Summary]\nPREV-GOAL keep-me\n\n[New Conversation]\n')).toBe(true);
    expect(t.text).not.toContain('<file-operations>');
    expect(t.text).not.toContain('## Compacted Summary');
    expect(t.text).toContain('[User]\nORIGINAL_GOAL');
    expect(t.text).toContain('[Assistant]\nChanging');
    expect(t.text).toContain('[Assistant tool calls]\nedit_file({"path":"src/p.ts"');
    expect(t.text).toContain('[Tool result: edit_file]\nHEAD-');
    expect(t.text).toContain('chars omitted');
    expect(t.text).toContain('-TAIL');
    expect(t.text).not.toContain('JSON.stringify');
    expect([...ops.read]).toEqual(['old.ts']);
    expect([...ops.modified]).toEqual(['src/p.ts']);
  });

  it('超预算:只丢新对话最旧的条目并标记条数,上一摘要与最新条目完整保留', () => {
    const msgs: ChatMessage[] = [
      summaryMessage('PREV keep'),
      ...Array.from({ length: 400 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i} ` + 'x'.repeat(200))),
    ];
    const t = buildTranscript(msgs, fresh(), 6_000);
    expect(t.omitted).toBeGreaterThan(0);
    expect(t.text.startsWith('[Existing Summary]\nPREV keep')).toBe(true);
    expect(t.text).toContain('earlier entries omitted');
    expect(t.text).toContain('m399 ');
    expect(t.text).not.toContain('[User]\nm0 ');
    const short = buildTranscript([mk('user', 'hi'), mk('assistant', 'yo')], fresh(), 100);
    expect(short.text).toBe('[User]\nhi\n\n[Assistant]\nyo');
    expect(short.omitted).toBe(0);
  });

  it('图片等非文本 part 转成占位,注入的 system 块不转写', () => {
    const msgs: ChatMessage[] = [
      mk('system', 'injected instructions'),
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:...' } }] } as any,
    ];
    const t = buildTranscript(msgs, fresh(), 10_000);
    expect(t.text).toBe('[User]\nlook\n[image_url omitted; inspect the original artifact if needed]');
  });
});

describe('rowCoverage — 检查点对某一行的覆盖状态(hydrate 与 compactSession 同一把尺)', () => {
  it('无检查点全部 uncovered;边界行按 id 认:更早覆盖、同一毫秒的邻行原样回放、行内切点 partial', () => {
    expect(rowCoverage({ id: 'a', timestamp: 5 }, null)).toBe('uncovered');
    const cp = { id: 'c', summary: 's', throughTimestamp: 10, throughMessageId: 'x', throughToolCallId: 't3' };
    expect(rowCoverage({ id: 'a', timestamp: 9 }, cp)).toBe('covered');
    expect(rowCoverage({ id: 'a', timestamp: 10 }, cp)).toBe('uncovered'); // 同一毫秒的邻行:重复安全,吞掉才丢数据
    expect(rowCoverage({ id: 'b', timestamp: 11 }, cp)).toBe('uncovered');
    expect(rowCoverage({ id: 'x', timestamp: 10 }, cp)).toBe('partial');
    expect(rowCoverage({ id: 'x', timestamp: 10 }, { ...cp, throughToolCallId: undefined })).toBe('covered');
  });
  it('时间戳缺失 / 非法 → uncovered(未知不是「最早」);老检查点(无行 id)维持 <= 语义', () => {
    const cp = { id: 'c', summary: 's', throughTimestamp: 10, throughMessageId: 'x' };
    expect(rowCoverage({ id: 'a' }, cp)).toBe('uncovered');
    expect(rowCoverage({ id: 'a', timestamp: 0 }, cp)).toBe('uncovered');
    expect(rowCoverage({ id: 'a', timestamp: Number.NaN }, cp)).toBe('uncovered');
    const legacy = { id: 'c', summary: 's', throughTimestamp: 10 };
    expect(rowCoverage({ id: 'a', timestamp: 10 }, legacy)).toBe('covered');
    expect(rowCoverage({ id: 'a', timestamp: 11 }, legacy)).toBe('uncovered');
    expect(rowCoverage({ id: 'a' }, legacy)).toBe('uncovered');
  });
});

describe('summaryMessage — run 内与 hydrate 同一构造器,带连续性契约', () => {
  it('头 + 连续性一句 + 摘要;isSummaryMessage 只认这个头', () => {
    const m = summaryMessage('## Goal\nfoo');
    expect(m.role).toBe('system');
    const text = String(m.content);
    expect(text).toContain('do not restart the task or redo finished work');
    expect(text.endsWith('## Goal\nfoo')).toBe(true);
    expect(isSummaryMessage(m)).toBe(true);
    expect(isSummaryMessage(mk('system', 'other'))).toBe(false);
    expect(isSummaryMessage(mk('user', text))).toBe(false);
  });
});

describe('文件操作机械追踪(借 pi:清单正确性与摘要模型脱钩)', () => {
  const fresh = (): FileOps => ({ read: new Set(), modified: new Set() });

  it('extractFileOps:JSON 字符串与对象两种 tool_calls 形态都吃;读写分池', () => {
    const ops = fresh();
    extractFileOps(
      JSON.stringify([
        { function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
        { function: { name: 'edit_file', arguments: { path: 'src/b.ts', old_string: 'x', new_string: 'y' } } },
      ]),
      ops,
    );
    expect([...ops.read]).toEqual(['src/a.ts']);
    expect([...ops.modified]).toEqual(['src/b.ts']);
  });

  it('extractFileOps:apply_patch 从补丁信封提取 Add/Update/Delete/Move 的路径', () => {
    const ops = fresh();
    const patch =
      '*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** Add File: docs/new.md\n+hi\n*** Move to: docs/renamed.md\n*** End Patch';
    extractFileOps([{ function: { name: 'apply_patch', arguments: { patch } } }], ops);
    expect([...ops.modified].sort()).toEqual(['docs/new.md', 'docs/renamed.md', 'src/c.ts']);
  });

  it('extractFileOps:坏 JSON / 非数组 / 未知工具一律静默跳过', () => {
    const ops = fresh();
    extractFileOps('not-json', ops);
    extractFileOps({ nope: 1 }, ops);
    extractFileOps([{ function: { name: 'run_bash', arguments: '{"command":"ls"}' } }], ops);
    extractFileOps([{ function: { name: 'read_file', arguments: '{bad' } }], ops);
    expect(ops.read.size + ops.modified.size).toBe(0);
  });

  it('formatFileOps:readOnly = read − modified;两清单皆空返回空串', () => {
    const ops = fresh();
    expect(formatFileOps(ops)).toBe('');
    ops.read.add('a.ts').add('b.ts');
    ops.modified.add('b.ts');
    const block = formatFileOps(ops);
    expect(block).toContain('<modified-files>\nb.ts\n</modified-files>');
    expect(block).toContain('<read-files>\na.ts\n</read-files>');
    expect(block).not.toMatch(/<read-files>[\s\S]*b\.ts/);
  });

  it('parseFileOps ∘ formatFileOps 往返 + 继承叠加:跨压缩单调累积', () => {
    const round1 = fresh();
    round1.read.add('a.ts');
    round1.modified.add('b.ts');
    const summary1 = '## Goal\nfoo' + formatFileOps(round1);
    // 下一次压缩:先解析继承,再叠加新窗口(a.ts 本轮被改 → 应迁入 modified)
    const { ops: inherited, stripped } = parseFileOps(summary1);
    expect(stripped).not.toContain('<file-operations>');
    expect(stripped).toContain('## Goal');
    extractFileOps([{ function: { name: 'write_file', arguments: '{"path":"a.ts","content":""}' } }], inherited);
    const block2 = formatFileOps(inherited);
    expect(block2).toContain('<modified-files>\na.ts\nb.ts\n</modified-files>');
    expect(block2).not.toContain('<read-files>');
  });

  it('parseFileOps:无块的摘要原样返回', () => {
    const { ops, stripped } = parseFileOps('plain summary');
    expect(stripped).toBe('plain summary');
    expect(ops.read.size + ops.modified.size).toBe(0);
  });
});

describe('compactSystemPrompt — 增量 PRESERVE/UPDATE 指令 + 可配指令 / 关注点', () => {
  it('无上一检查点:基础骨架,不带增量指令;有:附 UPDATE/preserve 指令;Goal 段要求逐字引用当前请求', () => {
    const base = compactSystemPrompt(false);
    expect(base).toContain('## In progress / Next steps');
    expect(base).toContain('quoting the user\'s current request verbatim');
    expect(base).not.toContain('[Existing Summary]');
    const inc = compactSystemPrompt(true);
    expect(inc.startsWith(base)).toBe(true); // 基础骨架逐字节不动,只在尾部附加
    expect(inc).toContain('UPDATE it instead of restarting');
    expect(inc).toContain('preserve every still-relevant fact');
  });
  it('settings.prompt 整体替换基础指令;instructions 与 /compact <focus> 一起进 Additional focus', () => {
    const p = compactSystemPrompt(true, { prompt: 'CUSTOM BASE', instructions: 'always keep ticket ids' }, 'focus on the migration');
    expect(p.startsWith('CUSTOM BASE')).toBe(true);
    expect(p).toContain('UPDATE it instead of restarting');
    expect(p).toContain('Additional focus: always keep ticket ids\nfocus on the migration');
    expect(compactSystemPrompt(false, {}, '')).not.toContain('Additional focus');
  });
});
