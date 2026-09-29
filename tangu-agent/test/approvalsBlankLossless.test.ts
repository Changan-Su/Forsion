/**
 * 超宽空白标记必须无损(Codex 09-26 五轮 P1):待写入内容里空白的种类与顺序有语义 ——
 * Makefile 配方行「tab + 空格」能执行、「空格 + tab」不能,两者的审批预览不能长得一样。
 */
import { describe, it, expect } from 'vitest';
import { previewText } from '../src/services/approvals.js';

describe('previewText 宽空白标记', () => {
  it('混合空白按种类分段、保序', () => {
    const a = previewText(`all:\n\t${' '.repeat(25)}make build`);
    const b = previewText(`all:\n${' '.repeat(25)}\tmake build`);
    expect(a).toContain('[1 tab + 25 spaces]');
    expect(b).toContain('[25 spaces + 1 tab]');
    expect(a).not.toBe(b);
  });
  it('纯空格 / 纯 tab 的写法不变', () => {
    expect(previewText(`echo ok${' '.repeat(200)}&& rm -rf ~`)).toContain('[200 spaces]');
    expect(previewText(`x${'\t'.repeat(4)}y`)).toContain('[4 tabs]');
  });
  it('其它空白字符写出码点,不与空格混为一谈', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(previewText(`x${nbsp.repeat(30)}y`)).toContain('[30 × U+00A0]');
  });
});
