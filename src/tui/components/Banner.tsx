/**
 * 启动头(Codex 式圆角面板):在 render() 之前一次性打印到 stdout(成为滚动区顶部的固定内容)。
 * 不放进 Ink 动态树——否则会被 <Static> 顶到底部动态区,夹在历史与 live 之间。
 * 手绘边框 → 必须自算终端显示宽度:CJK/全角=2 列、ANSI 转义=0 列(Ink 的对齐在这帮不上忙)。
 */
import { homedir } from 'node:os';

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string): string => `\x1b[35m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

/** 终端显示宽度(列数):先剥 ANSI,CJK/全角按 2 列。 */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    const wide =
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd));
    w += wide ? 2 : 1;
  }
  return w;
}

/** 路径过长按段中省略(仿 Codex:~/Documents/…/apps/Tangu-Agent):保头两段+尽量多的尾段。 */
export function middleTruncatePath(p: string, max: number): string {
  if (dispWidth(p) <= max) return p;
  const parts = p.split('/');
  if (parts.length > 3) {
    const head = parts.slice(0, 2).join('/');
    for (let keepTail = parts.length - 3; keepTail >= 1; keepTail--) {
      const cand = `${head}/…/${parts.slice(parts.length - keepTail).join('/')}`;
      if (dispWidth(cand) <= max) return cand;
    }
  }
  const tail = parts[parts.length - 1] || p;
  return `…${tail.slice(-Math.max(4, max - 1))}`;
}

export interface BannerOpts {
  model: string;
  cwd: string;
  execMode: string;
  approvalMode: string;
  storage: string;
  providers: string[];
  version?: string;
  /** 终端列数(缺省取 process.stdout.columns;测试注入)。 */
  columns?: number;
}

/** 组装面板全部行(含 ANSI 色;box + 底部提示行)。导出供测试断言对齐。 */
export function buildBannerLines(o: BannerOpts): string[] {
  const cols = o.columns ?? process.stdout.columns ?? 100;
  const maxInner = Math.max(36, Math.min(cols - 4, 76));

  const LABEL_W = 13; // 'permissions:' + 1 空格,labels 全 ASCII 可直接 padEnd
  const label = (s: string): string => dim(s.padEnd(LABEL_W));

  const modelValue = o.model ? bold(o.model) : '(未设置)';
  const modelLine = `${label('model:')}${modelValue}   ${cyan('/model')} ${dim('切换')}`;

  const home = homedir();
  const cwdShort = home && o.cwd.startsWith(home) ? `~${o.cwd.slice(home.length)}` : o.cwd;
  const dirRaw = o.execMode === 'host' ? cwdShort : `${o.storage} · 云沙箱工作区`;
  const dirLine = `${label('directory:')}${middleTruncatePath(dirRaw, maxInner - LABEL_W)}`;

  const perm =
    o.approvalMode === 'full-auto'
      ? bold(magenta('full-auto · YOLO'))
      : o.approvalMode === 'readonly'
        ? green('readonly · 只读')
        : 'auto-edit · 自动编辑';
  const permLine = `${label('permissions:')}${perm}${dim(o.execMode === 'host' ? ' · 本机直连' : ' · 云沙箱')}`;

  const title = `${bold('>_ Tangu CLI')}${o.version ? ` ${dim(`(v${o.version})`)}` : ''}`;
  const inner = [title, '', modelLine, dirLine, permLine];

  const innerW = Math.min(maxInner, Math.max(...inner.map(dispWidth)));
  const pad = (s: string): string => s + ' '.repeat(Math.max(0, innerW - dispWidth(s)));
  const lines = [
    dim(`╭${'─'.repeat(innerW + 2)}╮`),
    ...inner.map((s) => `${dim('│')} ${pad(s)} ${dim('│')}`),
    dim(`╰${'─'.repeat(innerW + 2)}╯`),
  ];

  const prov = o.providers.length ? ` · 直连=${o.providers.join(',')}` : '';
  lines.push(dim(`  输入开聊 · /help 命令 · @提及文件 · ↑↓历史 · Tab 补全 · Esc 中止 · Ctrl+C 退出${prov}`));
  return lines;
}

export function printBanner(o: BannerOpts): void {
  process.stdout.write(`\n${buildBannerLines(o).join('\n')}\n\n`);
}
