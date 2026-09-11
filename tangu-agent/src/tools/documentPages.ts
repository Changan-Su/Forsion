/**
 * read_document 的纯逻辑：把解析结果切成带**真页码**的页，供页码标注 / 页内检索 / 页区间读取。
 * 页码是引用契约 `[[file.pdf#page=N]]` 的上游——必须用 LiteParse 的 pages[].pageNum，不是数组下标
 * （targetPages / 加密页跳过时下标会错位）。
 * 另含 docx 的纯文本兜底 docxText：机器上没有 LibreOffice 时 read_document 靠它读 docx。
 */
import { inflateRawSync } from 'node:zlib';

export interface DocPage {
  /** 1-based 真页码。 */
  page: number;
  text: string;
}

const PAGE_BREAK = /\n-{5}\n/;

/**
 * LiteParse 的 markdown 用 `-----` 分页但不带页码：段数与 pages 对齐时按序配页码（保住表格等
 * markdown 结构），对不齐（正文里本来就有横线、或 LibreOffice 转换来的文档）退回逐页纯文本。
 */
export function pagesOf(markdown: string, parsed: { pageNum: number; text: string }[]): DocPage[] {
  const parts = markdown.split(PAGE_BREAK);
  const useMd = parts.length === parsed.length;
  return parsed.map((p, i) => ({ page: p.pageNum, text: (useMd ? parts[i] : p.text).trim() }));
}

/** `12` / `12-18` / `3,7,9-11` → 页码判定；格式非法返回 null（调用方回报错误，不静默全读）。 */
export function pageFilter(spec: string): ((page: number) => boolean) | null {
  const ranges: [number, number][] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] === undefined ? a : parseInt(m[2], 10);
    if (!a || !b || b < a) return null;
    ranges.push([a, b]);
  }
  return (page) => ranges.some(([a, b]) => page >= a && page <= b);
}

/** 带页码标记的正文——标记行本身就是模型写引用锚点的依据。 */
export function renderPages(pages: DocPage[]): string {
  return pages.map((p) => `--- page ${p.page} ---\n\n${p.text}`).join('\n\n');
}

/** 页内**字面量**检索（大小写不敏感的子串，不是语义检索）：命中行 + 真页码。 */
export function grepPages(pages: DocPage[], phrase: string, max = 40): { hits: string[]; total: number } {
  const needle = phrase.toLowerCase();
  const hits: string[] = [];
  let total = 0;
  for (const p of pages) {
    for (const line of p.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.toLowerCase().includes(needle)) continue;
      total++;
      if (hits.length < max) hits.push(`p.${p.page} | ${trimmed.slice(0, 300)}`);
    }
  }
  return { hits, total };
}

/**
 * 引用锚点(渲染层据此定位文件,必须唯一):
 *  - 文档在 vault 里 → **vault 相对路径**(库里有同名文件也不会认错);
 *  - 不在 vault 里 → **原样的绝对路径**(桌面端据此只读打开;给文件名的话渲染层全库找不着 = 灰链)。
 * vault 内的相对路径统一吐 POSIX 斜杠(反斜杠在 wikilink 里没法往回还原)。
 */
export function citeRefFor(abs: string, vaultRoot: string | null, sep = '/'): string {
  if (!vaultRoot) return abs;
  const root = vaultRoot.replace(/[\\/]+$/, '');
  const prefix = root + sep;
  if (!abs.startsWith(prefix) || abs.length <= prefix.length) return abs;
  return abs.slice(prefix.length).split(/[\\/]/).join('/');
}

/**
 * read_document 输出头里那句「怎么引用」。**按后缀分叉,不按有没有解析出 pages 分叉** ——
 * 装了 LibreOffice 的机器上 docx/xlsx/pptx 走的是 soffice→PDF→PDFium 同一条管线,pages 齐全
 * (实测 docx 出 6 页),拿它当判据 = office 被判成「有真页码,可以教」,bug 原样存活且更隐蔽。
 *
 * 只有 PDF 该教页码锚,两条理由:
 *  1. 非 PDF 的页码是 **LibreOffice 的排版**,与用户在 Word/WPS 里看到的分页没有必然对应 ——
 *     一条指向错页的可点链接,比一条明显的坏链更难被发现;
 *  2. 渲染端(desktop 的 parsePdfLinkInner)只认 `.pdf`,docx 的 `#page=` 会被当成标题锚拿去
 *     全库找笔记,渲染成灰色未解析链(点了没反应,不报错不打日志)。
 */
export function citeHowFor(absPath: string, citeRef: string): string {
  return /\.pdf$/i.test(absPath)
    ? `cite a spot as [[${citeRef}#page=N]], or [[${citeRef}#page=N&q=<short exact phrase>]] to highlight the sentence`
    : `cite it as [[${citeRef}]] — no page anchors for this format (only PDFs carry real page numbers)`;
}

/** search 分支尾巴上那句「读到上下文之后怎么引用」。分叉理由同 citeHowFor。 */
export function citeHitFor(absPath: string, citeRef: string): string {
  return /\.pdf$/i.test(absPath)
    ? `[[${citeRef}#page=<n>&q=<a short phrase copied from that line>]]`
    : `[[${citeRef}]]`;
}

/**
 * docx 纯文本兜底(机器上没有 LibreOffice、走不了 soffice→PDF 时):取 word/document.xml 的正文 ——
 * 一段一行,表格一行一条 `| 格 | 格 |`,run 里的 tab/换行照留,公式(<m:t>)按字面拍平。
 * 只收 <w:t>/<m:t>,所以修订删除(<w:delText>)与域代码(<w:instrText>)天然不进。
 * <mc:Fallback> 是文本框等的旧版(VML)副本,内容与 <mc:Choice> 相同 —— 不剔掉,框里的字会出现两遍。
 * ponytail: 只取正文,页眉页脚/脚注/批注在别的 part;主文档 part 认死 word/document.xml(个别导出器
 * 叫 document2.xml,真遇到再按 _rels/.rels 的 officeDocument 关系去找)。
 */
export function docxText(docx: Buffer): string {
  const xml = unzipEntry(docx, 'word/document.xml')?.toString('utf8');
  if (!xml) return '';
  const out: string[] = [];
  let inText = false;
  let cellDepth = 0; // 单元格里的分段/换行压成空格,一行表格才不会被拆成好几行
  for (const [tok] of xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '').matchAll(/<[^>]*>|[^<]+/g)) {
    if (tok[0] !== '<') {
      if (inText) out.push(decodeXmlText(tok));
      continue;
    }
    const [, close, name] = /^<(\/?)([\w:]+)/.exec(tok) ?? [];
    const ends = close === '/' || tok.endsWith('/>'); // 结束标签或自闭合:这个元素到此为止
    if (name === 'w:t' || name === 'm:t') inText = !ends;
    else if (name === 'w:tab' && !tok.includes('=')) out.push('\t'); // 带属性的是 <w:tabs> 里的制表位定义,不是字符
    else if (name === 'w:br' || name === 'w:cr' || (name === 'w:p' && ends)) out.push(cellDepth ? ' ' : '\n');
    else if (name === 'w:tr') out.push(cellDepth ? ' ' : ends ? '\n' : '|');
    else if (name === 'w:tc' && !ends) { cellDepth++; out.push(' '); }
    else if (name === 'w:tc' && close) {
      cellDepth--;
      if (out[out.length - 1] === ' ') out.pop();
      out.push(' |');
    }
  }
  return out.join('').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXmlText(s: string): string {
  return s.replace(/&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([\da-fA-F]+));/g, (m, name?: string, dec?: string, hex?: string) => {
    if (name) return XML_ENTITIES[name];
    const cp = dec ? Number(dec) : parseInt(hex!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

const ZIP_EOCD = Buffer.from('PK\x05\x06', 'latin1');
/** 解压上限:50MB 的 docx 按 deflate 的极限压缩比能胀到 GB 级,在引擎进程里解必须封顶(zip 炸弹)。 */
const UNZIP_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 从 zip 里取一个条目,没有 → null;坏档读越界会抛(调用方兜)。按中央目录找,本地头里 size 记 0 的
 * (data descriptor)也能读。ponytail: 只认 stored/deflate,不做 zip64/加密/CRC 校验 —— docx 用不到。
 */
function unzipEntry(zip: Buffer, name: string): Buffer | null {
  const eocd = zip.lastIndexOf(ZIP_EOCD);
  if (eocd < 0) return null;
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = zip.readUInt16LE(eocd + 10); n > 0 && zip.readUInt32LE(p) === 0x02014b50; n--) {
    const nameLen = zip.readUInt16LE(p + 28);
    if (zip.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const local = zip.readUInt32LE(p + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(p + 20));
      const method = zip.readUInt16LE(p + 10);
      return method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: UNZIP_MAX_BYTES }) : null;
    }
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return null;
}
