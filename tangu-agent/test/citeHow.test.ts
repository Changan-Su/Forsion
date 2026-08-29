/** read_document 的「怎么引用」话术分叉。页码锚教错 = 用户点到的是一条打不开的灰链
 *  (docx 的 `#page=`),或者更坏:一条指向 LibreOffice 排版页而非 Word 分页的可点链接。 */
import { describe, it, expect } from 'vitest';
import { citeHowFor, citeHitFor } from '../src/tools/documentPages.js';

describe('read_document 引用话术', () => {
  it('PDF:教页码锚 + q= 引语', () => {
    expect(citeHowFor('/v/书.pdf', '书.pdf')).toContain('[[书.pdf#page=N]]');
    expect(citeHowFor('/v/书.pdf', '书.pdf')).toContain('&q=');
    expect(citeHitFor('/v/书.pdf', '书.pdf')).toBe('[[书.pdf#page=<n>&q=<a short phrase copied from that line>]]');
  });

  it('docx/xlsx/pptx/odt:只教裸链接,一个 page= 都不许出现', () => {
    for (const f of ['报告.docx', '表.xlsx', '幻灯.pptx', '文.odt', 'a.doc', 'b.xls', 'c.ppt']) {
      expect(citeHowFor(`/v/${f}`, f), f).not.toContain('page=');
      expect(citeHowFor(`/v/${f}`, f), f).toContain(`[[${f}]]`);
      expect(citeHitFor(`/v/${f}`, f), f).toBe(`[[${f}]]`);
    }
  });

  it('后缀判定大小写不敏感,且只认结尾(`x.pdf.docx` 是 docx)', () => {
    expect(citeHowFor('/v/A.PDF', 'A.PDF')).toContain('page=');
    expect(citeHowFor('/v/x.pdf.docx', 'x.pdf.docx')).not.toContain('page=');
  });
});
