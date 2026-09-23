/** 本地技能停用状态。状态与 SKILL.md 分开，避免重命名目录或改动播种指纹。 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { agentsDir, skillsDir } from '../core/tanguHome.js';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GLOBAL_FILE = '.disabled-skills.json';
const INHERITED_FILE = '.disabled-inherited-skills.json';
const writes = new Map<string, Promise<void>>();

export type DisableTarget = 'user' | 'agent' | 'inherited';

function stateFile(target: DisableTarget, agentSlug?: string): string {
  if (target === 'user') return path.join(skillsDir(), GLOBAL_FILE);
  if (!agentSlug || !SAFE_SLUG.test(agentSlug)) throw new Error('Invalid agent slug');
  return target === 'agent'
    ? path.join(agentsDir(), agentSlug, 'skills', GLOBAL_FILE)
    : path.join(agentsDir(), agentSlug, INHERITED_FILE);
}

export async function disabledSkillNames(target: DisableTarget, agentSlug?: string): Promise<Set<string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(stateFile(target, agentSlug), 'utf8')); }
  catch { return new Set(); }
  const skills = typeof parsed === 'object' && parsed !== null && 'skills' in parsed ? (parsed as { skills?: unknown }).skills : null;
  return new Set(Array.isArray(skills) ? skills.filter((s): s is string => typeof s === 'string' && SAFE_SLUG.test(s)) : []);
}

/** 同进程串行更新 + 原子替换，避免两个窗口连续切换时丢掉另一项状态。 */
export async function setSkillDisabled(target: DisableTarget, slug: string, disabled: boolean, agentSlug?: string): Promise<void> {
  if (!SAFE_SLUG.test(slug)) throw new Error('Invalid skill slug');
  const file = stateFile(target, agentSlug);
  const previous = writes.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const names = await disabledSkillNames(target, agentSlug);
    if (disabled) names.add(slug); else names.delete(slug);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ skills: [...names].sort() }, null, 2) + '\n', { flag: 'wx' });
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  });
  writes.set(file, next);
  try { await next; } finally { if (writes.get(file) === next) writes.delete(file); }
}
