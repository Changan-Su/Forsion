/** 启动面板:显示宽度(CJK=2 列/ANSI=0 列)/路径中省略/边框对齐(全行等宽)。 */
import { describe, it, expect } from 'vitest';
import { dispWidth, stripAnsi, middleTruncatePath, buildBannerLines } from './components/Banner.js';

describe('dispWidth', () => {
  it('ASCII=1 列,CJK=2 列,ANSI=0 列', () => {
    expect(dispWidth('abc')).toBe(3);
    expect(dispWidth('中文')).toBe(4);
    expect(dispWidth('\x1b[36m/model\x1b[0m 切换')).toBe('/model 切换'.length + 2); // 切换=+2
    expect(stripAnsi('\x1b[1mx\x1b[0m')).toBe('x');
  });
});

describe('middleTruncatePath', () => {
  it('不超限原样返回;超限保头两段+尾段,中间 …', () => {
    expect(middleTruncatePath('~/a/b', 40)).toBe('~/a/b');
    const long = '~/Documents/Project/Forsion/apps/Tangu-Agent';
    const cut = middleTruncatePath(long, 30);
    expect(dispWidth(cut)).toBeLessThanOrEqual(30);
    expect(cut.startsWith('~/Documents/…/')).toBe(true);
    expect(cut.endsWith('Tangu-Agent')).toBe(true);
  });
});

describe('buildBannerLines', () => {
  const opts = {
    model: 'kimi-k2',
    cwd: '~/Documents/Project/Forsion/apps/Tangu-Agent',
    execMode: 'host',
    approvalMode: 'full-auto',
    storage: 'PGlite',
    providers: ['xai'],
    version: '1.0.0',
    columns: 100,
  };

  it('边框上下同宽,box 内每行等宽(剥 ANSI 后)', () => {
    const lines = buildBannerLines(opts);
    const box = lines.slice(0, -1); // 最后一行是提示行,不在框内
    const widths = box.map((l) => dispWidth(l));
    expect(new Set(widths).size).toBe(1);
    expect(stripAnsi(box[0]).startsWith('╭')).toBe(true);
    expect(stripAnsi(box[box.length - 1]).startsWith('╰')).toBe(true);
  });

  it('内容齐备:标题+版本/model+切换提示/目录/权限 YOLO/直连提示行', () => {
    const flat = buildBannerLines(opts).map(stripAnsi).join('\n');
    expect(flat).toContain('>_ Tangu CLI (v1.0.0)');
    expect(flat).toContain('model:');
    expect(flat).toContain('kimi-k2');
    expect(flat).toContain('/model 切换');
    expect(flat).toContain('directory:');
    expect(flat).toContain('permissions:');
    expect(flat).toContain('full-auto · YOLO');
    expect(flat).toContain('直连=xai');
  });

  it('窄终端:目录被截仍对齐;未设模型显示占位', () => {
    const lines = buildBannerLines({ ...opts, model: '', approvalMode: 'auto-edit', columns: 48 });
    const box = lines.slice(0, -1);
    expect(new Set(box.map((l) => dispWidth(l))).size).toBe(1);
    const flat = box.map(stripAnsi).join('\n');
    expect(flat).toContain('(未设置)');
    expect(flat).toContain('…');
  });
});
