/**
 * Forsion 插件捆绑包(bundle):一个 Forsion 桌面插件目录(共享域 plugins/<id>/,以 manifest.json 为标志)
 * 可内嵌引擎侧内容,引擎**原地读取**,不做拷贝(避免双份漂移):
 *
 *   plugins/<id>/tangu-plugins/<pid>/tangu-plugin.json → 追加进插件搜索根(loader.resolvePluginsDirs ③)
 *   plugins/<id>/skills/<slug>/SKILL.md                → 追加进技能扫描根(localSkills,内置<bundle<用户)
 *   plugins/<id>/agents/<slug>/config.toml             → **播种一次**进 agentsDir()(已存在永不覆盖:
 *                                                        agent 落地后是带 MEMORY/LOG 的活体,bundle 升级
 *                                                        不得清洗用户改动;卸载 bundle 也保留 agent)
 *
 * 识别全靠标志文件,manifest.json 无新增字段;单独安装的引擎插件/技能/agent 不受影响。
 * `TANGU_PLUGINS=off` / `TANGU_PLUGINS_DIR` 覆盖时整体停用(云 worker/docker 均设了后者,bundle 天然不进云端)。
 * 纯 standalone(共享域=home)下扫的就是 ~/.tangu/plugins,放个 bundle 进去同样奏效。
 *
 * 符号链接纪律:bundle 目录与其内容根(tangu-plugins/skills/agents)一律拒绝符号链接——desktop 侧的
 * Dirent 扫描本就不认它们,引擎若跟随会产生「桌面看不见、级联管不着」的隐身子插件(codex P2-1)。
 * (用户插件目录 ~/.tangu/plugins 里的符号链接是 --link 开发流,归 loader 管,不受此限。)
 */
import { promises as fs } from 'node:fs';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { agentsDir, forsionSharedDir } from '../core/tanguHome.js';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 真目录(存在、是目录、且不是符号链接)。 */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 共享域 plugins/ 下的 bundle 目录(有 manifest.json 的真目录;符号链接不认)。搜索停用时返回 []。 */
export function bundleDirs(): string[] {
  if (process.env.TANGU_PLUGINS === 'off') return [];
  if (process.env.TANGU_PLUGINS_DIR) return []; // 显式覆盖 = 只认那一个目录(云端/docker 形态)
  const root = path.join(forsionSharedDir(), 'plugins');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return []; // 目录不存在是常态(无桌面/未装任何 Forsion 插件)
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    if (isRealDir(dir) && existsSync(path.join(dir, 'manifest.json'))) dirs.push(dir);
  }
  return dirs.sort(); // 确定性顺序(与 loader 的排序纪律一致)
}

/** 各 bundle 的内嵌引擎插件根(<bundle>/tangu-plugins),供 resolvePluginsDirs 追加。 */
export function bundleEnginePluginRoots(): string[] {
  return bundleDirs()
    .map((d) => path.join(d, 'tangu-plugins'))
    .filter(isRealDir);
}

/** 各 bundle 的内嵌技能根(<bundle>/skills),供 listLocalSkills 追加。 */
export function bundleSkillRoots(): string[] {
  return bundleDirs()
    .map((d) => path.join(d, 'skills'))
    .filter(isRealDir);
}

/**
 * 把各 bundle 内嵌的 agent(<bundle>/agents/<slug>/,以 config.toml 为标志)播种进 agentsDir()。
 * 仅目标 slug 尚不存在时复制(含 SOUL.md/Library/skills);幂等、永不覆盖。
 * 原子纪律(codex P1-2/P1-3):先整目录拷到同盘 staging(符号链接一律解引用,播种结果自包含——
 * 否则卸载 bundle 后链接断裂,「保留的 agent」名存实亡),校验后 rename 落位;任何失败清理 staging,
 * 绝不把半成品留在 agentsDir(半成品会被「已存在→跳过」永久卡死,agent 无法自愈)。
 * 返回本次新播种的 slug 列表(供日志/调用方感知)。
 */
export async function seedBundleAgents(): Promise<string[]> {
  const seeded: string[] = [];
  for (const bundle of bundleDirs()) {
    const agentsRoot = path.join(bundle, 'agents');
    if (!isRealDir(agentsRoot)) continue;
    let names: string[];
    try {
      names = (await fs.readdir(agentsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const slug of names) {
      if (!SAFE_SLUG.test(slug)) {
        console.warn(`[tangu] bundle ${path.basename(bundle)} 内嵌 agent "${slug}" slug 非法(须 kebab-case),跳过`);
        continue;
      }
      const src = path.join(agentsRoot, slug);
      if (!existsSync(path.join(src, 'config.toml'))) continue; // 非 agent 目录
      const dest = path.join(agentsDir(), slug);
      if (existsSync(dest)) continue; // 已播种/同名已有 → 永不覆盖(活体保护)
      const staging = path.join(agentsDir(), `.seed-${slug}-${process.pid}-${seeded.length}`);
      try {
        await fs.mkdir(agentsDir(), { recursive: true });
        await fs.cp(src, staging, { recursive: true, dereference: true });
        await fs.rename(staging, dest); // 目标同时被别的进程占下 → rename 抛错走 catch,保持不覆盖语义
        seeded.push(slug);
        console.log(`[tangu] 已从 bundle ${path.basename(bundle)} 播种 agent "${slug}"`);
      } catch (e: any) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        console.warn(`[tangu] bundle agent "${slug}" 播种失败(已清理,忽略):${e?.message || e}`);
      }
    }
  }
  return seeded;
}
