/**
 * 收件箱存的审批预览(storedPreview):保留换行(`# 注释\nrm -rf` 不能被折成一行看成注释)、
 * 伪装字符转义、超长时显式标出截断 —— 旧版 displayText(…, 2000) 折换行且截断不留痕(Codex 09-25 复审)。
 */
import { describe, it, expect } from 'vitest';
import { storedPreview } from '../src/services/pendingApprovals.js';

describe('storedPreview', () => {
  it('保留换行:注释后的下一条命令仍在自己那一行', () => {
    expect(storedPreview('$ echo ok # safe\nrm -rf ~/Documents').split('\n')).toEqual(['$ echo ok # safe', 'rm -rf ~/Documents']);
  });
  it('方向控制字符转义成可见文字', () => {
    expect(storedPreview('echo ‮gnp.exe')).toContain('\\u202E');
  });
  it('超长:截断并标出截掉了多少', () => {
    const s = storedPreview(`x${'y'.repeat(25_000)}`);
    expect(s.length).toBeLessThan(21_000);
    expect(s).toMatch(/… \[truncated 5001 chars\]$/);
  });
});
