/**
 * read_document 的 docx 纯文本兜底。没装 LibreOffice 时 LiteParse 抛「LibreOffice is not installed」,
 * 以前整个工具直接报错 —— 2026-09-11 Windows 用户读 .docx 失败,模型转去手写 python-docx 脚本连环出错。
 * 夹具 docx 在测试里现拼(stored 与 deflate 条目都有);LiteParse 用 mock 钉住「没装」与「装了」两种机器 ——
 * 开发机多半装着 LibreOffice,不 mock 根本走不到兜底这条。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const parse = vi.hoisted(() => vi.fn());
vi.mock('@llamaindex/liteparse', () => ({
  LiteParse: class {
    parse(file: string) {
      return parse(file);
    }
  },
}));

import { HOST_TOOLS } from '../src/tools/hostExec.js';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 最小 zip 写入器:[条目名, 内容, 是否 deflate]。 */
function zip(entries: [string, string, boolean][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    // 本地头与中央目录共有的一段:所需版本、压缩方法、CRC、压缩后/原始大小、名长(时间日期留 0)
    const fields = (b: Buffer, at: number) => {
      b.writeUInt16LE(20, at);
      b.writeUInt16LE(deflate ? 8 : 0, at + 4);
      b.writeUInt32LE(crc32(raw), at + 10);
      b.writeUInt32LE(data.length, at + 14);
      b.writeUInt32LE(raw.length, at + 18);
      b.writeUInt16LE(nameBuf.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 4);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    fields(entry, 6);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (...texts: string[]) => `<w:p>${texts.map(run).join('')}</w:p>`;
const cell = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(t)}</w:tc>`;
const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>' +
  para('第三问：', '模型求解') + // 一段拆成两个 run
  para('a &lt; b &amp;&amp; c') +
  `<w:p>${run('目标 ')}<m:oMath><m:r><m:t>Z=x+y</m:t></m:r></m:oMath></w:p>` +
  // 段落属性里的制表位定义(带属性的 <w:tab>)不是字符;run 里的 <w:tab/> 才是
  `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs></w:pPr>${run('序号')}<w:r><w:tab/></w:r>${run('内容')}</w:p>` +
  `<w:p><w:del w:id="1" w:author="t"><w:r><w:delText>已删除</w:delText></w:r></w:del>${run('保留')}</w:p>` +
  '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
  `<w:tr>${cell('指标')}${cell('取值')}</w:tr><w:tr>${cell('误差')}${cell('0.05')}</w:tr></w:tbl>` +
  para('结论段') +
  '<w:sectPr/></w:body></w:document>';
const DOCX = zip([
  [
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    false,
  ],
  [
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    false,
  ],
  ['word/document.xml', DOCUMENT_XML, true],
]);

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-doc-docx-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('read_document:docx 在没装 LibreOffice 的机器上退回纯文本', () => {
  it('LiteParse 报「LibreOffice is not installed」→ 照样读出段落与表格,引用头只给裸 [[path]]', async () => {
    const file = join(dir, '第三问.docx');
    writeFileSync(file, DOCX);
    // 与 liteparse 2.2.1 原生库里的报错逐字一致
    parse.mockRejectedValue(new Error(
      'conversion error: LibreOffice is not installed. Please install LibreOffice to convert office documents. ' +
      'On macOS: brew install --cask libreoffice, On Ubuntu: apt-get install libreoffice, On Windows: choco install libreoffice-fresh',
    ));
    const ctx = { cwd: dir } as any;

    const out = await HOST_TOOLS.read_document.execute({ path: '第三问.docx' }, ctx);
    expect(out).not.toMatch(/^Error/);
    expect(out.split('\n')[0]).toContain(`[[${file}]]`);
    expect(out).not.toContain('#page=');
    expect(out).toContain('第三问：模型求解');
    expect(out).toContain('a < b && c');
    expect(out).toContain('目标 Z=x+y');
    expect(out).toMatch(/^序号\t内容$/m);
    expect(out).toContain('| 指标 | 取值 |\n| 误差 | 0.05 |');
    expect(out).toContain('保留');
    expect(out).not.toContain('已删除');

    // 第二趟 search 命中备忘:头里仍说明「没有排版页」,引用仍是裸链接
    const hit = await HOST_TOOLS.read_document.execute({ path: '第三问.docx', search: '误差' }, ctx);
    expect(hit.split('\n')[0]).toContain('no page layout');
    expect(hit).toContain('p.1 | | 误差 | 0.05 |');
    expect(hit).toContain(`cite it as [[${file}]].`);
  });

  it('装了 LibreOffice(LiteParse 成功)→ 用它的真分页,不走纯文本兜底', async () => {
    const file = join(dir, 'with-soffice.docx');
    writeFileSync(file, DOCX);
    parse.mockResolvedValue({
      text: 'from soffice p1\n-----\nfrom soffice p2',
      pages: [{ pageNum: 1, text: 'from soffice p1' }, { pageNum: 2, text: 'from soffice p2' }],
    });

    const out = await HOST_TOOLS.read_document.execute({ path: file }, { cwd: dir } as any);
    expect(out).toContain('(2 pages)');
    expect(out).toContain('--- page 2 ---\n\nfrom soffice p2');
    expect(out).not.toContain('指标');
  });
});
