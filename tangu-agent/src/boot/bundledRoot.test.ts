/**
 * 跑热更新下来的引擎时,启动器经 TANGU_BUNDLED_ROOT 告知安装包那份包根。两处要认它:
 * 随包的 Chrome 扩展目录(路径不能跟着引擎版本目录变)、沙箱的受保护路径(依赖都在安装包那份里)。
 */
import { afterEach, expect, it } from 'vitest';
import path from 'node:path';
import { forsionSharedDir } from '../core/tanguHome.js';
import { protectedHostPaths } from '../sandbox/hostSandboxProtection.js';
import { extensionDir } from '../services/browserExtension.js';

const prev = process.env.TANGU_BUNDLED_ROOT;
afterEach(() => {
  if (prev === undefined) delete process.env.TANGU_BUNDLED_ROOT; else process.env.TANGU_BUNDLED_ROOT = prev;
});

it('没设 TANGU_BUNDLED_ROOT:扩展目录在自己这份包根下', () => {
  delete process.env.TANGU_BUNDLED_ROOT;
  expect(extensionDir()).toBe(path.resolve(import.meta.dirname, '..', '..', 'browser-extension'));
});

it('设了 TANGU_BUNDLED_ROOT:扩展目录指安装包那份,受保护路径多出安装包包根', () => {
  const bundled = path.resolve('/opt/Forsion/resources/tangu-server');
  process.env.TANGU_BUNDLED_ROOT = bundled;
  expect(extensionDir()).toBe(path.join(bundled, 'browser-extension'));
  expect(protectedHostPaths()).toContain(bundled);
});

it('共享域的 engine/ 目录(热更新的落点)恒在受保护路径里', () => {
  delete process.env.TANGU_BUNDLED_ROOT;
  expect(protectedHostPaths()).toContain(path.resolve(forsionSharedDir(), 'engine'));
});
