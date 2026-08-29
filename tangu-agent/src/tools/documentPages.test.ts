/**
 * read_document 的分页/检索纯函数。页码错 = 引用条点到错的页,是这个功能唯一致命的失败形态,
 * 所以每条断言都盯着"真页码"(pageNum),不是数组下标。
 */
import { describe, it, expect } from 'vitest';
import { pagesOf, pageFilter, renderPages, grepPages, citeRefFor } from './documentPages.js';

const parsed = [
  { pageNum: 3, text: 'alpha plain' },
  { pageNum: 4, text: 'beta plain' },
];

describe('pagesOf', () => {
  it('markdown 段数与页数对齐时用 markdown(保住表格),页码取 pageNum', () => {
    expect(pagesOf('| a | b |\n-----\nbeta *md*', parsed)).toEqual([
      { page: 3, text: '| a | b |' },
      { page: 4, text: 'beta *md*' },
    ]);
  });
  it('对不齐(正文自带横线)退回逐页纯文本,页码不受影响', () => {
    expect(pagesOf('x\n-----\ny\n-----\nz', parsed)).toEqual([
      { page: 3, text: 'alpha plain' },
      { page: 4, text: 'beta plain' },
    ]);
  });
});

describe('pageFilter', () => {
  it('单页 / 区间 / 逗号组合', () => {
    expect([1, 2, 3].filter(pageFilter('2')!)).toEqual([2]);
    expect([1, 2, 3, 4].filter(pageFilter('2-3')!)).toEqual([2, 3]);
    expect([1, 3, 7, 9, 10, 11].filter(pageFilter('3,9-11')!)).toEqual([3, 9, 10, 11]);
  });
  it('非法格式返回 null(调用方报错,绝不静默全读)', () => {
    for (const bad of ['', 'abc', '3-1', '0', '1-', '1,,2']) expect(pageFilter(bad)).toBeNull();
  });
});

describe('renderPages', () => {
  it('每页带真页码标记', () => {
    expect(renderPages([{ page: 18, text: 'hi' }])).toBe('--- page 18 ---\n\nhi');
  });
});

describe('grepPages', () => {
  const pages = [
    { page: 5, text: 'The aim of this book\nis to provide a guide' },
    { page: 18, text: 'The AIM again here' },
  ];
  it('大小写不敏感,命中行带真页码', () => {
    expect(grepPages(pages, 'the aim').hits).toEqual(['p.5 | The aim of this book', 'p.18 | The AIM again here']);
  });
  it('无命中 total=0', () => {
    expect(grepPages(pages, 'zzz')).toEqual({ hits: [], total: 0 });
  });
  it('超出上限只截 hits,total 仍是全量', () => {
    const many = [{ page: 2, text: Array.from({ length: 5 }, (_, i) => `hit ${i}`).join('\n') }];
    const r = grepPages(many, 'hit', 2);
    expect(r.hits.length).toBe(2);
    expect(r.total).toBe(5);
  });
});

describe('citeRefFor(引用锚点身份)', () => {
  it('vault 内 → vault 相对路径(库里有同名文件也不会认错)', () => {
    expect(citeRefFor('/v/资料/研究.pdf', '/v')).toBe('资料/研究.pdf');
    expect(citeRefFor('/v/研究.pdf', '/v/')).toBe('研究.pdf');
  });
  it('vault 外 / 无 vault → 绝对路径原样(渲染层照它只读打开;给文件名会全库找不着)', () => {
    expect(citeRefFor('/tmp/研究.pdf', '/v')).toBe('/tmp/研究.pdf');
    expect(citeRefFor('/tmp/研究.pdf', null)).toBe('/tmp/研究.pdf');
    expect(citeRefFor('/vault-backup/研究.pdf', '/vault')).toBe('/vault-backup/研究.pdf'); // 前缀相似但不是同一目录
  });
  it('Windows 分隔符也吐 POSIX 斜杠(wikilink 里不能有反斜杠)', () => {
    expect(citeRefFor('C:\\v\\资料\\研究.pdf', 'C:\\v', '\\')).toBe('资料/研究.pdf');
  });
});
