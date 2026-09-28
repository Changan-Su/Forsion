/**
 * Git 设置(config.json 的 `git` 段;桌面「设置 → Git」):
 *   branchPrefix       分支前缀。PROJECT 详情「新建分支」预填它;agent 替用户建分支时也照用(随 `[Git state]` 注入)。缺省 `tangu/`
 *   commitInstructions 提交说明。生成提交信息时附给模型;agent 替用户提交时也照做。缺省空
 *   forceWithLease     推送一律带 --force-with-lease(改写过历史的分支也能推;远端被别人推进过则仍拒绝)。缺省 false
 *
 * 口径同 compactionSettings:逐键 normalize,非法键抛错不写,null = 删键回缺省;锁内读改写(段里手写的其它键原样保留)。
 * 云端 worker 的 config.json 是所有用户共用的 → 路由层按 hostExec 关门。
 */
import { getRawSection, updateSection } from '../core/config.js';

export interface GitSettings {
  branchPrefix: string;
  commitInstructions: string;
  forceWithLease: boolean;
}

export const DEFAULT_GIT_SETTINGS: GitSettings = { branchPrefix: 'tangu/', commitInstructions: '', forceWithLease: false };

/** 提交说明每轮会随 `[Git state]` 进上下文,别让它无界。 */
export const COMMIT_INSTRUCTIONS_MAX = 1000;
const PREFIX_MAX = 40;
/** 只收 ref 安全的字符;拼上名字之后是否合法由建分支时的 `git check-ref-format --branch` 判。 */
const PREFIX_RE = /^[A-Za-z0-9._/-]*$/;

/** 一层原始值 → 只含合法字段的部分设置(非法字段丢弃,不抛)。 */
export function normalizeGitSettings(raw: unknown): Partial<GitSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<GitSettings> = {};
  if (typeof r.branchPrefix === 'string') {
    const v = r.branchPrefix.trim();
    if (v.length <= PREFIX_MAX && PREFIX_RE.test(v)) out.branchPrefix = v;
  }
  if (typeof r.commitInstructions === 'string') out.commitInstructions = r.commitInstructions.replace(/\0/g, '').trim().slice(0, COMMIT_INSTRUCTIONS_MAX);
  if (typeof r.forceWithLease === 'boolean') out.forceWithLease = r.forceWithLease;
  return out;
}

/** 单测:只在内存里读写,绝不碰真家目录的 config.json。 */
let memory: Record<string, unknown> | null = null;
export function resetGitSettingsForTest(seed?: Record<string, unknown>): void {
  memory = seed ? { ...seed } : {};
}

function globalLayer(): unknown {
  if (memory) return memory;
  try { return getRawSection('git'); } catch { return undefined; }
}

/** 当前生效值(缺省 ← config.json)。每次现读:设置页改完,下一次动作 / 下一个 run 就生效,不用重启。 */
export function gitSettings(): GitSettings {
  return { ...DEFAULT_GIT_SETTINGS, ...normalizeGitSettings(globalLayer()) };
}

/** 设置页的写口:patch 逐键,null = 删掉回缺省;不认识 / 不合法的键 → 抛错不写。返回写后的生效值。 */
export function updateGitSettings(patch: Record<string, unknown>): GitSettings {
  const apply = (raw: unknown): Record<string, unknown> => {
    const next: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) { delete next[key]; continue; }
      const norm = normalizeGitSettings({ [key]: value }) as Record<string, unknown>;
      if (!(key in norm)) throw new Error(`invalid git.${key}`);
      next[key] = norm[key];
    }
    return next;
  };
  if (memory) memory = apply(memory);
  else updateSection('git', apply);
  return gitSettings();
}
