/**
 * 仓库自带的「会执行程序」的 git 配置 × 用户的信任(Codex 评审 09-27 P0)。
 *
 * 项目目录不可信:克隆 / 解压来的文件夹可以自带 `.git/config` 与钩子,过滤器、钩子、sshCommand、凭据助手都能以用户权限跑任意命令。
 * - **read 级**风险(过滤器 / include):`status`、`diff` 读工作区时就会执行 —— 未信任时,面板摘要与每轮 `[Git state]` 不读改动,
 *   生成提交信息也拒。这条堵的是**零点击**路径:打开项目详情就会跑的 `status`。
 * - **write 级**风险(再加钩子、sshCommand、凭据助手等):提交 / 建分支 / 推送会执行 —— 未信任时拒,用户点「信任」后照他自己的配置跑。
 * 只看仓库级(local)配置与钩子目录:全局 / 系统配置是用户自己写的,本来就信。
 *
 * 信任记录住宿主家目录 `tanguHome()/git-trust.json`,按 git common dir 的 realpath + dev/ino 绑定 ——
 * 授权绝不住在被授权的目录里;目录删了重建 / 换成另一个仓 = 不再信任(同 desktop dirIdentity 的口径)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runBoundedProcess } from '../utils/boundedProcess.js';
import { tanguHome } from '../core/tanguHome.js';
import { GIT_SCRUBBED_ENV, READ_ONLY_GIT_ARGS, gitExecutable } from './gitExec.js';

const READ_KEYS = [
  /^filter\..+\.(clean|smudge|process)$/i, /^include\.path$/i, /^includeif\..+\.path$/i,
  // 开了它 git 还读一份 config.worktree(里面也能放过滤器);这里不展开读 —— 按 read 级拦(fail closed,极少有仓用它)
  /^extensions\.worktreeconfig$/i,
];
const WRITE_KEYS = [
  ...READ_KEYS,
  /^core\.(hookspath|fsmonitor|sshcommand|gitproxy|askpass)$/i,
  /^credential\.(.+\.)?helper$/i,
  /^diff\.external$/i, /^diff\..+\.(textconv|command)$/i, /^merge\..+\.driver$/i,
  /^gpg\.(.+\.)?program$/i,
  /^uploadpack\.packobjectshook$/i, /^remote\..+\.(uploadpack|receivepack|vcs)$/i,
  // 推送的传输:放开 ext:: 之类的协议、改写 URL,都能让一次推送去执行仓库指定的程序
  /^protocol\.(.+\.)?allow$/i, /^url\..+\.(insteadof|pushinsteadof)$/i,
];
/** 远端地址用了 `<transport>::<address>` 写法(ext:: 直接是一条命令,其余会调 git-remote-<transport> 助手)。 */
const HELPER_URL_KEY = /^remote\..+\.(url|pushurl)$/i;
const HELPER_URL = /^[a-z][a-z0-9+.-]*::/i;

export interface RepoRisk {
  /** git common dir 的绝对路径(信任按它记)。 */
  commonDir: string;
  /** 读工作区(status / diff)就会执行的配置项。 */
  read: string[];
  /** 提交 / 建分支 / 推送会执行的配置项与钩子(含 read 那些)。 */
  write: string[];
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; reason?: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of GIT_SCRUBBED_ENV) delete env[key];
  const r = await runBoundedProcess(gitExecutable(), [...READ_ONLY_GIT_ARGS, '-C', cwd, ...args], { cwd, env, timeoutMs: 5000, maxOutputBytes: 512 * 1024 });
  return { code: r.code, stdout: r.stdout, reason: r.reason };
}

/** 扫仓库级配置与钩子目录(只读,不执行任何配置)。不是仓 / 没有 git → null。 */
export async function repoConfigRisks(cwd: string): Promise<RepoRisk | null> {
  const dirs = await git(cwd, ['rev-parse', '--git-common-dir']);
  if (dirs.code !== 0 || dirs.reason) return null;
  const commonDir = path.resolve(cwd, dirs.stdout.trim());
  const listed = await git(cwd, ['config', '--local', '--list', '-z']);
  // 读不出来(配置写坏了 / 超时)按有风险算:fail closed,别把一份看不懂的配置当成干净的
  if (listed.code !== 0 || listed.reason) return { commonDir, read: ['config (unreadable)'], write: ['config (unreadable)'] };
  const pairs = listed.stdout.split('\0').filter(Boolean).map((entry) => {
    const cut = entry.indexOf('\n');
    return cut < 0 ? { key: entry, value: '' } : { key: entry.slice(0, cut), value: entry.slice(cut + 1) };
  });
  const read = [...new Set(pairs.map((p) => p.key).filter((k) => READ_KEYS.some((re) => re.test(k))))];
  const write = [...new Set(pairs.map((p) => p.key).filter((k) => WRITE_KEYS.some((re) => re.test(k))))];
  for (const { key, value } of pairs) if (HELPER_URL_KEY.test(key) && HELPER_URL.test(value.trim())) write.push(`${key}=${value.trim().slice(0, 60)}`);
  // 钩子目录里会被执行的:软链一律算(git 跟着它执行,指向哪里都一样);.sample 不算;POSIX 上的真文件还得有执行位
  const hooksDir = path.join(commonDir, 'hooks');
  for (const entry of await fs.readdir(hooksDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.endsWith('.sample')) continue;
    if (entry.isSymbolicLink()) { write.push(`hooks/${entry.name}`); continue; }
    if (!entry.isFile()) continue;
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(hooksDir, entry.name)).catch(() => null);
      if (!st || !(st.mode & 0o111)) continue;
    }
    write.push(`hooks/${entry.name}`);
  }
  return { commonDir, read, write };
}

// ── 信任记录 ──────────────────────────────────────────────────────────────

interface TrustEntry { dev: number; ino: number; at: number }
const storeFile = (): string => path.join(tanguHome(), 'git-trust.json');

async function readStore(): Promise<Record<string, TrustEntry>> {
  try {
    const raw = JSON.parse(await fs.readFile(storeFile(), 'utf8'));
    return raw && typeof raw.repos === 'object' && raw.repos ? raw.repos : {};
  } catch { return {}; }
}

async function identity(commonDir: string): Promise<{ key: string; dev: number; ino: number } | null> {
  const key = await fs.realpath(commonDir).catch(() => null);
  const st = key ? await fs.stat(key).catch(() => null) : null;
  return key && st ? { key, dev: st.dev, ino: st.ino } : null;
}

export async function isRepoTrusted(commonDir: string): Promise<boolean> {
  const id = await identity(commonDir);
  const entry = id ? (await readStore())[id.key] : undefined;
  return !!id && !!entry && entry.dev === id.dev && entry.ino === id.ino;
}

/** 记下「用户信任这个仓的配置」。ponytail: 读改写不加锁 —— 两个窗口同一毫秒各信任一个仓,后写的会盖掉先写的那条,
 *  代价只是那个仓下次再问一遍;真要并发安全再换成 core/config 那套跨进程锁。 */
export async function trustRepo(commonDir: string): Promise<void> {
  const id = await identity(commonDir);
  if (!id) throw new Error('repository not found');
  const repos = await readStore();
  repos[id.key] = { dev: id.dev, ino: id.ino, at: Date.now() };
  const file = storeFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
}

/** 这一级的风险是否拦着:没有风险 / 已信任 → null;否则返回风险项(调用方决定是拒还是先信任)。 */
export async function untrustedRisks(cwd: string, level: 'read' | 'write'): Promise<{ commonDir: string; risks: string[] } | null> {
  const risk = await repoConfigRisks(cwd);
  const risks = risk ? risk[level] : [];
  if (!risk || !risks.length || await isRepoTrusted(risk.commonDir)) return null;
  return { commonDir: risk.commonDir, risks };
}
