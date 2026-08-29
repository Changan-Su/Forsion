/**
 * read_document 的纯逻辑：把解析结果切成带**真页码**的页，供页码标注 / 页内检索 / 页区间读取。
 * 页码是引用契约 `[[file.pdf#page=N]]` 的上游——必须用 LiteParse 的 pages[].pageNum，不是数组下标
 * （targetPages / 加密页跳过时下标会错位）。
 */

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
