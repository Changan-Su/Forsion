/**
 * manage_skill —— 让运行中的 agent 把「这类活怎么干」的可复用**程序性知识**沉淀成本地技能
 * (参考 hermes 的 skill_manage;懒版:单 SKILL.md、用户级作用域、**用户驱动**、不带 curator/GC)。
 * 落盘 ~/.tangu/skills/<slug>/SKILL.md(frontmatter name/description + 正文),经 use_skill 按需加载。
 *
 * 与 manage_agent 对称:mode:'host' → 仅本地 host 会话可见;云端(sandbox)无持久家目录,永不暴露。
 * 只写用户级技能目录;**包内置技能受保护**——不得 create 覆盖 / update / delete(护住只读来源)。
 * 刻意不做:curator / 用量遥测 / references 包 / 后台自动写技能——那些只有接了「自主写入到规模」才需要,YAGNI。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';
import { skillsDir } from '../../core/tanguHome.js';
import { slugify } from '../../agents/agentRegistry.js';
import { parseFrontmatter, isBuiltinSkillName } from '../../skills/localSkills.js';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const skillMdPath = (slug: string) => path.join(skillsDir(), slug, 'SKILL.md');

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 组装 SKILL.md:frontmatter(name + 可选 description)+ 正文。frontmatter 值强制单行(解析器按行读)。 */
function composeSkillMd(name: string, description: string, body: string): string {
  const lines = ['---', `name: ${oneLine(name)}`];
  const d = oneLine(description);
  if (d) lines.push(`description: ${d}`);
  lines.push('---', '', String(body ?? '').trim(), '');
  return lines.join('\n');
}

export const manageSkillProvider: ToolProvider = {
  id: 'builtin:manage_skill',
  tools: () => [
    {
      name: 'manage_skill',
      mode: 'host',
      deferred: true, // P0-2:1.5KB schema,低频管理面 → 按需装载
      deferHint: 'Save or update a reusable local skill ("how to do X") for future sessions.',
      definition: {
        type: 'function',
        function: {
          name: 'manage_skill',
          description:
            'Create/update/delete/list your OWN local skills — reusable procedural know-how for a CLASS of task ("how to do X for this user"). ' +
            'When the user corrects how you work, or you work out a non-obvious technique/workflow worth reusing, capture it with action="create" (or "update" an existing one) so future sessions start already knowing; skills load on demand via use_skill. ' +
            'Name at the CLASS level (e.g. "deploy-forsion-web"), never a one-off ("fix-bug-today"). Do NOT capture environment failures, "tool X is broken" claims, or transient errors — they harden into refusals that bite you later. ' +
            'action ∈ create | update | delete | list. create needs name + instructions; update needs slug + instructions. Built-in skills are read-only.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'update', 'delete', 'list'], description: 'The operation' },
              slug: { type: 'string', description: 'Unique skill id (lowercase alphanumerics and hyphens); required for update/delete, optional for create (derived from name)' },
              name: { type: 'string', description: 'Display name (required for create)' },
              description: { type: 'string', description: 'One-sentence summary shown in the skill catalog so future-you knows when to load it (recommended)' },
              instructions: { type: 'string', description: 'The SKILL.md body — the actual step-by-step how-to (required for create/update)' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args) => {
        const action = String(args.action || '');
        try {
          if (action === 'list') {
            let names: string[];
            try {
              names = (await fs.readdir(skillsDir(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
            } catch {
              return '(no user skills yet)';
            }
            const rows: string[] = [];
            for (const slug of names.sort()) {
              if (!(await fileExists(skillMdPath(slug)))) continue;
              const { meta } = parseFrontmatter(await fs.readFile(skillMdPath(slug), 'utf-8').catch(() => ''));
              const builtin = await isBuiltinSkillName(slug);
              rows.push(`- ${slug}: ${meta.name || slug}${meta.description ? ` — ${meta.description}` : ''}${builtin ? ' [built-in, read-only]' : ''}`);
            }
            return rows.length ? rows.join('\n') : '(no user skills yet)';
          }

          if (action === 'delete') {
            const slug = oneLine(args.slug);
            if (!SAFE_SLUG.test(slug)) return 'Error: delete 需要合法 slug(小写字母/数字/连字符)';
            if (await isBuiltinSkillName(slug)) return `Error: 「${slug}」是内置技能,受保护不可删除`;
            if (!(await fileExists(skillMdPath(slug)))) return `未找到技能: ${slug}`;
            await fs.rm(path.join(skillsDir(), slug), { recursive: true, force: true });
            return `已删除技能: ${slug}`;
          }

          if (action === 'create' || action === 'update') {
            const body = String(args.instructions ?? '');
            if (!body.trim()) return 'Error: create/update 需要 instructions(技能正文)';

            let slug: string;
            if (action === 'create') {
              if (!args.name) return 'Error: create 需要 name';
              slug = args.slug ? oneLine(args.slug) : slugify(String(args.name));
              if (!SAFE_SLUG.test(slug)) return `Error: 非法 slug: ${slug}`;
              if (await isBuiltinSkillName(slug)) return `Error: 「${slug}」与内置技能同名(受保护);换个名字`;
              if (await fileExists(skillMdPath(slug))) return `Error: 技能「${slug}」已存在;用 action="update" 修改`;
            } else {
              slug = oneLine(args.slug);
              if (!SAFE_SLUG.test(slug)) return 'Error: update 需要合法 slug';
              if (await isBuiltinSkillName(slug)) return `Error: 「${slug}」是内置技能,受保护不可改`;
              if (!(await fileExists(skillMdPath(slug)))) return `Error: 未找到要更新的技能: ${slug}`;
            }

            // name/description:create 用给定值;update 缺省沿用现有 frontmatter(免得每次都重报)。
            let name = args.name != null ? String(args.name) : '';
            let description = args.description != null ? String(args.description) : '';
            if (action === 'update' && (!name || args.description == null)) {
              const prev = parseFrontmatter(await fs.readFile(skillMdPath(slug), 'utf-8').catch(() => '')).meta;
              if (!name) name = prev.name || slug;
              if (args.description == null) description = prev.description || '';
            }

            await fs.mkdir(path.join(skillsDir(), slug), { recursive: true });
            await fs.writeFile(skillMdPath(slug), composeSkillMd(name || slug, description, body), 'utf-8');
            return `已${action === 'create' ? '创建' : '更新'}技能: ${slug}(${name || slug})。将经 use_skill 按需加载。`;
          }

          return `Error: 未知 action: ${action}`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
