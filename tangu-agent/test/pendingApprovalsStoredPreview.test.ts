/**
 * 收件箱存的审批预览(storedPreview):保留换行(`# 注释\nrm -rf` 不能被折成一行看成注释)、
 * 伪装字符转义 —— 旧版 displayText(…, 2000) 折换行且截断不留痕(Codex 09-25 复审)。
 * 放不下全文 → null(不截断):批准执行的是完整参数,卡上少一截 = 批了看不见的尾巴(Codex 09-25 三轮 #3)。
 */
import { describe, it, expect } from 'vitest';
import { storedPreview, STORED_PREVIEW_MAX } from '../src/services/pendingApprovals.js';

describe('storedPreview', () => {
  it('保留换行:注释后的下一条命令仍在自己那一行', () => {
    expect(storedPreview('$ echo ok # safe\nrm -rf ~/Documents')!.split('\n')).toEqual(['$ echo ok # safe', 'rm -rf ~/Documents']);
  });
  it('方向控制字符转义成可见文字', () => {
    expect(storedPreview('echo \u202Egnp.exe')).toContain('\\u202E');
  });
  it('恰好到上限:全文原样,一个字不少、不带截断标记', () => {
    const tail = '\nrm -rf ~/tail';
    const p = `$ echo ${'y'.repeat(STORED_PREVIEW_MAX - 7 - tail.length)}${tail}`;
    expect(p.length).toBe(STORED_PREVIEW_MAX);
    const s = storedPreview(p);
    expect(s).toBe(p);
    expect(s).not.toMatch(/truncated/);
  });
  it('超上限一个字:不截断,返回 null(调用方据此不排队)', () => {
    expect(storedPreview(`x${'y'.repeat(STORED_PREVIEW_MAX)}`)).toBeNull();
    expect(storedPreview(`x${'y'.repeat(25_000)}`)).toBeNull();
  });
  it('按净化后的长度算:原文不到上限、伪装字符转义后超了 → 也放不下', () => {
    const raw = '\u202E'.repeat(Math.ceil(STORED_PREVIEW_MAX / 6) + 1); // 每个 → 6 字的 `\u202E`
    expect(raw.length).toBeLessThan(STORED_PREVIEW_MAX);
    expect(storedPreview(raw)).toBeNull();
  });
});
