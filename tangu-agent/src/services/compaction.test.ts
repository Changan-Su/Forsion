import { describe, it, expect } from 'vitest';
import { extractFileOps, formatFileOps, foldWorkingWithSummary, parseFileOps, type FileOps } from './compaction.js';
import type { ChatMessage } from '../core/types.js';

function mk(role: string, content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

describe('foldWorkingWithSummary', () => {
  it('keeps leading system block + tail, replaces middle with one summary system msg', () => {
    const msgs: ChatMessage[] = [
      mk('system', 'sys1'),
      mk('system', 'sys2'),
      ...Array.from({ length: 20 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`)),
    ];
    const before = msgs.length;
    foldWorkingWithSummary(msgs, 'SUMMARY', 5);
    // head(2 system) + 1 summary + tail(5) = 8
    expect(msgs.length).toBe(8);
    expect(msgs[0].content).toBe('sys1');
    expect(msgs[1].content).toBe('sys2');
    expect((msgs[2] as any).role).toBe('system');
    expect(msgs[2].content).toContain('SUMMARY');
    // tail preserved (last 5 of original)
    expect(msgs[msgs.length - 1].content).toBe(`m19`);
    expect(before).toBe(22);
  });

  it('no-op when too short to fold', () => {
    const msgs: ChatMessage[] = [mk('system', 's'), mk('user', 'a'), mk('assistant', 'b')];
    const copy = msgs.map((m) => ({ ...m }));
    foldWorkingWithSummary(msgs, 'SUMMARY', 12);
    expect(msgs).toEqual(copy);
  });

  it('折叠边界落在 tool 结果批次中间:回退到该批次的 assistant,绝不产出孤立 role:tool', () => {
    const msgs: ChatMessage[] = [
      mk('system', 's'),
      ...Array.from({ length: 10 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`)),
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] } as any,
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'tool', content: `r${i}`, tool_call_id: `t${i}` }) as any),
      mk('assistant', 'final'),
    ];
    // 总长 19;名义边界 19-4=15 落在 tool 批次(12..17)→ 回退到 11(带 tool_calls 的 assistant)
    foldWorkingWithSummary(msgs, 'S', 4);
    expect(msgs.length).toBe(10); // head(1) + summary(1) + [assistant+6 tool+final](8)
    const roles = msgs.map((m: any) => m.role);
    const firstTool = roles.indexOf('tool');
    expect(firstTool).toBeGreaterThan(0);
    expect((msgs[firstTool - 1] as any).tool_calls).toBeTruthy(); // 第一条 tool 前必是它的 assistant
  });

  it('handles no leading system block', () => {
    const msgs: ChatMessage[] = Array.from({ length: 30 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`));
    foldWorkingWithSummary(msgs, 'S', 4);
    expect((msgs[0] as any).role).toBe('system'); // summary at front
    expect(msgs.length).toBe(5); // summary + tail(4)
  });

  it('摘要头带连续性契约(压缩点不重做已完成工作)', () => {
    const msgs: ChatMessage[] = Array.from({ length: 30 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`));
    foldWorkingWithSummary(msgs, 'S', 4);
    expect(msgs[0].content).toContain('do not restart the task or redo finished work');
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

describe('compactSystemPrompt — 增量压缩 PRESERVE/UPDATE 指令(借 pi,07-30 二轮)', () => {
  it('无上一检查点:基础骨架,不带增量指令;有:附 UPDATE/preserve 指令', async () => {
    const { compactSystemPrompt } = await import('./compaction.js');
    const base = compactSystemPrompt(false);
    expect(base).toContain('## In progress / Next steps');
    expect(base).not.toContain('[Existing Summary]');
    const inc = compactSystemPrompt(true);
    expect(inc.startsWith(base)).toBe(true); // 基础骨架逐字节不动,只在尾部附加
    expect(inc).toContain('UPDATE it instead of restarting');
    expect(inc).toContain('preserve every still-relevant fact');
  });
});

describe('buildCompactTranscript — 增量压缩上一检查点永不被截(Codex 评审 #7)', () => {
  it('新对话超长:只截其尾部,[Existing Summary] 完整保留在头', async () => {
    const { buildCompactTranscript } = await import('./compaction.js');
    const prev = 'PREV-GOAL keep-me';
    const convo = Array.from({ length: 4000 }, (_, i) => `User: m${i} ` + 'x'.repeat(20)).join('\n'); // >100k
    const t = buildCompactTranscript(prev, convo);
    expect(t.startsWith('[Existing Summary]\nPREV-GOAL keep-me')).toBe(true);
    expect(t).toContain('[New Conversation]');
    expect(t).toContain('m3999 ');       // 新对话尾部在
    expect(t).not.toContain('m0 ');      // 头部被预算截掉的是新对话,不是检查点
    expect(t.length).toBeLessThanOrEqual(60_000 + 200);
    // 无上一检查点:不加块头,原样(短的不截)
    expect(buildCompactTranscript('', 'User: hi\nAI: yo')).toBe('User: hi\nAI: yo');
  });
});
