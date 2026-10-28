import { describe, expect, it } from 'vitest';
import { correctionVerdict, DECISION_HI, DECISION_LO, looksLikeCorrection, verdictLine } from './judgeSignals.js';
import type { DecisionBrain } from '../seams/cloudBrain.js';

const brain = (answer: unknown, seen: any[] = []): DecisionBrain => ({
  decide: async (req) => {
    seen.push(req);
    if (answer instanceof Error) throw answer;
    return { model: 'decision-model-preview', answers: { correction: answer as any } };
  },
});

describe('决策闸 correctionVerdict', () => {
  it('两头听决策模型:词面漏掉的纠正算上,词面误报的问题放掉', async () => {
    expect(looksLikeCorrection('我这边一直是 pnpm 的。')).toBe(false);
    const hit = await correctionVerdict(brain({ type: 'noul', noul: DECISION_HI }), '可以用 npm install。', '我这边一直是 pnpm 的。');
    expect(hit).toMatchObject({ correction: true, by: 'decision', lexical: false });
    expect(looksLikeCorrection('不对称加密和对称加密有什么区别?')).toBe(true);
    const miss = await correctionVerdict(brain({ type: 'noul', noul: DECISION_LO }), '好的。', '不对称加密和对称加密有什么区别?');
    expect(miss).toMatchObject({ correction: false, by: 'decision', lexical: true });
  });

  it('含糊、出错、答非所问 → 退回词面,绝不抛', async () => {
    const mid = (DECISION_HI + DECISION_LO) / 2;
    expect(await correctionVerdict(brain({ type: 'noul', noul: mid }), 'x', '不对,用 pnpm')).toMatchObject({ correction: true, by: 'lexical', noul: mid });
    const down = await correctionVerdict(brain(new Error('cloud decision 401: unauthorized')), 'x', '好的,谢谢');
    expect(down).toMatchObject({ correction: false, by: 'lexical' });
    expect(verdictLine(down)).toMatch(/退回词面:cloud decision 401/);
    expect(await correctionVerdict(brain({ type: 'choice', choice: 'yes' }), 'x', '不对')).toMatchObject({ correction: true, by: 'lexical', error: 'no noul answer' });
  });

  it('只发文字:上一条回复取多段内容里的 text、只留尾巴;用户这句截断', async () => {
    const seen: any[] = [];
    await correctionVerdict(brain({ type: 'noul', noul: 0.9 }, seen), [{ type: 'text', text: 'A'.repeat(3000) }, { type: 'image_url', image_url: { url: 'data:' } }], 'B'.repeat(2000));
    const { state, questions } = seen[0];
    expect(state.previous_reply).toBe('A'.repeat(1500));
    expect(state.user_message).toBe('B'.repeat(600));
    expect(questions.correction.type).toBe('noul');
    expect(JSON.stringify(seen[0])).not.toContain('data:');
  });
});
