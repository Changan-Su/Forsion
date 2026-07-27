import { describe, it, expect } from 'vitest';
import { parseCommandFile, expandCustomCommand, type CustomCommand } from './customCommands.js';

const cmd = (body: string): CustomCommand => ({ name: 'x', description: '', body, file: '' });

describe('parseCommandFile', () => {
  it('带 frontmatter → 取出 description / argument-hint,正文剥干净', () => {
    const { meta, body } = parseCommandFile('---\ndescription: 复盘\nargument-hint: <路径>\n---\n审查 $ARGUMENTS。');
    expect(meta.description).toBe('复盘');
    expect(meta['argument-hint']).toBe('<路径>');
    expect(body).toBe('审查 $ARGUMENTS。');
  });

  it('无 frontmatter → 整篇即正文', () => {
    expect(parseCommandFile('就这一句').body).toBe('就这一句');
  });

  it('引号被剥掉', () => {
    expect(parseCommandFile('---\ndescription: "带引号"\n---\nbody').meta.description).toBe('带引号');
  });

  it('残缺 frontmatter 不当 frontmatter 处理', () => {
    const { meta, body } = parseCommandFile('---\ndescription: 没有闭合\n正文');
    expect(meta).toEqual({});
    expect(body).toContain('---');
  });
});

describe('expandCustomCommand', () => {
  it('$ARGUMENTS 替换成整串参数', () => {
    expect(expandCustomCommand(cmd('审查 $ARGUMENTS 吧'), 'src/a.ts src/b.ts')).toBe('审查 src/a.ts src/b.ts 吧');
  });

  it('$1..$9 按空白位取', () => {
    expect(expandCustomCommand(cmd('$2 然后 $1'), 'one two')).toBe('two 然后 one');
  });

  it('缺位的 $n 变空串而不是留字面量', () => {
    expect(expandCustomCommand(cmd('a$3b'), 'only')).toBe('ab');
  });

  it('正文没有占位符时参数追加到末尾(而不是被静默吞掉)', () => {
    expect(expandCustomCommand(cmd('固定提示词'), '额外说明')).toBe('固定提示词\n\n额外说明');
  });

  it('无参数时不留多余空行', () => {
    expect(expandCustomCommand(cmd('固定提示词'), '')).toBe('固定提示词');
  });

  it('$10 不被当成 $1 + "0"(留字面量;既然没有可识别的占位符,参数照常追加)', () => {
    expect(expandCustomCommand(cmd('$10'), 'a b')).toBe('$10\n\na b');
  });

  it('紧贴文字的 $n 也替换($3 后面跟字母不算边界,曾漏替换)', () => {
    expect(expandCustomCommand(cmd('a$1b'), 'X')).toBe('aXb');
  });
});
