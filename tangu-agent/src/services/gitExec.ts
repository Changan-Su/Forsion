/**
 * 用哪个 git(runtimeContext / gitTrust / gitActions 共用,单独成模块免得互相 import 成环)。
 * Apple's /usr/bin/git shim can start xcodebuild for each private sandbox cache;
 * these fixed native developer-tool locations avoid an unsandboxed xcrun probe. 都没有就交给 PATH
 * (桌面在垫片跑不起来时会把内置 git 排到 PATH 前面,见 desktop/electron/envPath.ts)。
 */
import { existsSync } from 'node:fs';

export function gitExecutable(): string {
  return process.platform === 'darwin'
    ? ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git'].find(existsSync) || 'git'
    : 'git';
}

/** 这几个环境变量会把 git 整个指到别的仓去(GIT_DIR 泄进来时 `-C cwd` 形同虚设);仓永远只由 -C 决定,一律剥掉。 */
export const GIT_SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE'];

/** 自动触发的**只读**路径的固定前缀:不分页、不抢索引锁、不跑 fsmonitor / 钩子 / 外部 diff、不验签也不调 gpg ——
 *  外来仓的 `.git/config` 能借这几处执行任意程序。⚠️关不掉的是过滤器(`filter.*.clean` 在 status / diff 读工作区时照跑),
 *  那一类由 gitTrust 在读之前先查、未信任就不读。 */
export const READ_ONLY_GIT_ARGS = [
  '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'gpg.program=',
];
