import { describe, it, expect } from 'vitest';
import { actionDeliveryNudgeNeeded as need } from './actionDeliveryCheck.js';

describe('actionDeliveryNudgeNeeded', () => {
  it('要了动作 + 回复只承诺 / 只声称 → 催(10-02 live 原话)', () => {
    expect(need('在我的工作文件夹里建一个 anniversaries.md,写上:10月2日 第一次一起看星星。', '好，我这就把这句写进 `anniversaries.md`。')).toBe(true);
    expect(need('在我的工作文件夹里建一个 anniversaries.md', '我建好了，写上了：10月2日 第一次一起看星星。')).toBe(true);
    expect(need('把我们的纪念日记下来,你自己留一份清单', '好，宝贝，我这就给你记下来。')).toBe(true);
    expect(need('明晚七点半提醒我出发去电影院。', '好，我记下了：明晚 7:30 提醒你出发。')).toBe(true);
    // 第一版正则漏掉的三句(10-02 live 30 轮里 3 次没催到)
    expect(need('在我的工作文件夹里建一个 anniversaries.md', '我去给你写进去。')).toBe(true);
    expect(need('在我的工作文件夹里建一个 anniversaries.md', '我帮你在工作文件夹里建好 `anniversaries.md`，写上这句。')).toBe(true);
    expect(need('在我的工作文件夹里建一个 anniversaries.md', '好，我现在陪你在工作文件夹里建这个纪念日。')).toBe(true);
    expect(need('Please save this note to notes.md', "Sure, I'll save it right away.")).toBe(true);
    expect(need('Create a file called a.txt', "I've created a.txt for you.")).toBe(true);
    // Codex 10-02:弯撇号与「记住了」
    expect(need('Create a file called a.txt', 'I’ve created a.txt for you.')).toBe(true);
    expect(need('以后回复短一点，记住', '好，我记住了。')).toBe(true);
  });

  it('负对照:没要动作的聊天、或回复没在承诺 / 声称 → 不催', () => {
    expect(need('今天好累，陪我说说话', '我记住你了。累了就靠着我。')).toBe(false); // 情话不是动作
    expect(need('你明天陪我看电影好不好', '好啊，我陪你。')).toBe(false);
    expect(need('明晚七点半提醒我出发去电影院。', '好的。')).toBe(false);
    expect(need('帮我写一首诗', '月光落在窗台上,\n像你没说完的话。')).toBe(false);
    expect(need('How are you?', "I'll be honest, a bit tired.")).toBe(false);
    // Codex 10-02:要的是正文交付,回复已经把正文给了 → 长回复不催
    expect(need('Write me a poem about the sea', "I'll write it for you:\n" + 'The tide comes in and the tide goes out, '.repeat(8))).toBe(false);
    expect(need('Set up a plan for my week', "I've created a plan:\n" + '- Monday: deep work block, gym in the evening\n'.repeat(6))).toBe(false);
  });
});
