import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_TOOLS } from './hostExec.js';
import type { ToolContext } from './toolTypes.js';

// 真 kit 要 Node ≥22.19,CI 的 vitest 跑在 Node 20 —— 这里用假 kit 钉住接线:
// TANGU_OFFICE_KIT → 转 PDF → liteparse 读 PDF 的真页 → 临时目录删掉;kit 失败 → 回落老链路。

/** 手写一份每页一句话的最小 PDF(xref 偏移按实算)。 */
function tinyPdf(lines: string[]): string {
  const objs: string[] = [];
  const pageIds = lines.map((_, i) => 3 + i * 2);
  const font = 3 + lines.length * 2;
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`);
  for (const [i, line] of lines.entries()) {
    const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 工作区 + 一个假 kit:render 时把输入/输出路径记进 calls.json,按 behavior 写 PDF 或抛错。 */
async function fixture(behavior: 'pdf' | 'throw') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-officekit-test-'));
  tempDirs.push(dir);
  const cwd = path.join(dir, 'workspace');
  await fs.mkdir(cwd);
  const calls = path.join(dir, 'calls.json');
  const kit = path.join(dir, 'kit.mjs');
  await fs.writeFile(kit, `import { writeFileSync } from 'node:fs';
export async function createConverter() {
  return {
    async render({ inputPath, outputPath }) {
      writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ inputPath, outputPath }));
      ${behavior === 'throw' ? "throw new Error('engine unavailable');" : `writeFileSync(outputPath, ${JSON.stringify(tinyPdf(['Hello page one', 'Hello page two']))});`}
    },
    async dispose() {},
  };
}
`);
  vi.stubEnv('TANGU_OFFICE_KIT', kit);
  const ctx = { userId: 'test', sessionId: 'test', appId: 'test', cwd } as ToolContext;
  const readCall = async () => JSON.parse(await fs.readFile(calls, 'utf8')) as { inputPath: string; outputPath: string };
  return { cwd, ctx, readCall };
}

describe('read_document × 随包 LibreOffice 转换引擎', () => {
  it('Office 文档先经 kit 转 PDF,按 PDF 的真页返回,临时目录用完即删', async () => {
    const { cwd, ctx, readCall } = await fixture('pdf');
    await fs.writeFile(path.join(cwd, 'report.docx'), 'not really a docx');
    const out = await HOST_TOOLS.read_document.execute({ path: 'report.docx' }, ctx);
    expect(out).toContain('report.docx (2 pages)');
    expect(out).toContain('Hello page two');
    const call = await readCall();
    expect(call.inputPath).toBe(path.join(cwd, 'report.docx'));
    expect(existsSync(path.dirname(call.outputPath))).toBe(false);
  });

  it('kit 失败 → 原文件交回原链路,kit 的错不外露,临时目录同样删掉', async () => {
    const { cwd, ctx, readCall } = await fixture('throw');
    await fs.writeFile(path.join(cwd, 'broken.xlsx'), 'not really an xlsx');
    const out = await HOST_TOOLS.read_document.execute({ path: 'broken.xlsx' }, ctx);
    // 原链路的结局看机器:装了 LibreOffice 的 liteparse 把它当文本读出来,没装(CI)就报解析失败 —— 两种都算回落成功。
    expect(out).toMatch(/not really an xlsx|^Error: document parsing failed/);
    expect(out).not.toContain('engine unavailable');
    expect(existsSync(path.dirname((await readCall()).outputPath))).toBe(false);
    // 失败那次的回落结果不进备忘:同一文件再读,还会再给引擎一次机会
    await fs.rm(path.join(path.dirname(cwd), 'calls.json'));
    await HOST_TOOLS.read_document.execute({ path: 'broken.xlsx' }, ctx);
    expect(existsSync(path.join(path.dirname(cwd), 'calls.json'))).toBe(true);
  });

  it('取消 / 超时打断转换 → 直接结束,不再起回落解析', async () => {
    const { cwd, ctx } = await fixture('throw');
    await fs.writeFile(path.join(cwd, 'slow.docx'), 'not really a docx');
    const abort = new AbortController();
    abort.abort();
    const out = await HOST_TOOLS.read_document.execute({ path: 'slow.docx' }, { ...ctx, signal: abort.signal });
    expect(out).toBe('Error: read_document was cancelled or timed out.');
  });

  it('非 Office 格式不碰 kit', async () => {
    const { cwd, ctx } = await fixture('pdf');
    await fs.writeFile(path.join(cwd, 'direct.pdf'), tinyPdf(['Only page']));
    const out = await HOST_TOOLS.read_document.execute({ path: 'direct.pdf' }, ctx);
    expect(out).toContain('direct.pdf (1 pages)');
    expect(existsSync(path.join(path.dirname(cwd), 'calls.json'))).toBe(false);
  });
});
