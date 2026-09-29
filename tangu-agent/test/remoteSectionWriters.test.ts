/**
 * 静态守卫(设备能力 MCP 方案 P1 · K4 §5-② / §6.3):config.json 的 `remote` 段(远程会话最高审批档 remote.maxApprovalMode,
 * C3 每次工具调用现读)只能由执行设备的桌面主进程在本机写(desktop/electron/remoteSessions.ts → updateHomeConfig)。
 * 引擎里任何路由 / 工具 / 服务都不许写它 —— 否则远端会话(或被提示注入的 run)就能经引擎把自己的审批档上限抬到 full-auto。
 *
 * 判法(只读源码文本):
 *   1. saveSection / updateSection 的第一个实参必须是字符串字面量,且不是 'remote'(变量名 = 什么段都能写,一律红,逐个审过再登记);
 *   2. updateConfigFile 的调用(core/config.ts 自己的两个段级包装与迁移除外)在调用体里不许出现 `remote` 这个词;
 *   3. 读侧:去掉注释后 `maxApprovalMode` 只许出现在 remoteOrigin.ts(读)。
 * 引擎源码本包不改;这条守卫防的是以后。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** 从 `(` 起配平括号,取出整个调用体(够用:源码里的字符串 / 注释不会让括号失配到跨函数)。 */
function callBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** 去掉注释(块注释 + 行首 / 空白后的 //;字符串里的 `http://` 不受影响),守卫只看代码。 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f).replace(/\\/g, '/'), src: stripComments(readFileSync(f, 'utf8')) }));

describe('config.json 的 remote 段只许桌面主进程在本机写', () => {
  it('扫描自检:源码树与写入口都找得到(防重构后正则脱节而静默全绿)', () => {
    expect(FILES.length).toBeGreaterThan(100);
    const calls = FILES.flatMap((f) => [...f.src.matchAll(/\b(saveSection|updateSection)\(/g)]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it('saveSection / updateSection:第一个实参一律是字符串字面量,且没有一处是 remote', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const m of f.src.matchAll(/\b(saveSection|updateSection)\(\s*([^,)]*)/g)) {
        const arg = m[2].trim();
        // core/config.ts 里是函数定义本身(export function saveSection(name: string, …))
        if (f.rel === 'core/config.ts' && /^name\b/.test(arg)) continue;
        const lit = /^'([A-Za-z]+)'$/.exec(arg);
        if (!lit || lit[1] === 'remote') bad.push(`${f.rel}: ${m[1]}(${arg}`);
      }
    }
    expect(bad, '新的段写入点:确认不是 remote 再改成字面量(变量段名 = 什么都能写)').toEqual([]);
  });

  it('updateConfigFile 的调用体里不出现 remote(整份读改写也不许顺手改 remote 段)', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const m of f.src.matchAll(/\bupdateConfigFile\(/g)) {
        const body = callBody(f.src, m.index! + m[0].length - 1);
        if (/\bremote\b/.test(body)) bad.push(`${f.rel}:${f.src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('maxApprovalMode 只在 remoteOrigin.ts 里被读;没有别的源码碰这个键', () => {
    const hits = FILES.filter((f) => /maxApprovalMode/.test(f.src)).map((f) => f.rel);
    expect(hits).toEqual(['services/remoteOrigin.ts']);
    const ro = FILES.find((f) => f.rel === 'services/remoteOrigin.ts')!.src;
    expect(ro).toMatch(/getRawSection\('remote'\)/);
    expect(ro).not.toMatch(/(saveSection|updateSection|updateConfigFile)\(/);
  });
});
