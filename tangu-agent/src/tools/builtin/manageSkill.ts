/**
 * manage_skill —— 让运行中的 agent 把「这类活怎么干」的可复用**程序性知识**沉淀成本地技能
 * (参考 hermes 的 skill_manage;懒版:单 SKILL.md、用户级作用域、**用户驱动**、不带 curator/GC)。
 * 落盘 ~/.tangu/skills/<slug>/SKILL.md(frontmatter name/description + 正文),经 use_skill 按需加载。
 *
 * 与 manage_agent 对称:mode:'host' → 仅本地 host 会话可见;云端(sandbox)无持久家目录,永不暴露。
 * 只写用户级技能目录;**包内置技能受保护**——不得 create 覆盖 / update / delete(护住只读来源)。
 * 刻意不做:curator / 用量遥测 / references 包 / 后台自动写技能——那些只有接了「自主写入到规模」才需要,YAGNI。
 *
 * 与随包的 skill-creator 技能配对(10-05):那份讲「怎么把技能写好」,这个工具负责「存到哪、怎么存」。两头互相指路 ——
 * 工具描述让模型在复杂场合先装载 skill-creator;skill-creator 开头的「In Forsion」一节让模型用本工具保存。
 * create / update 返回技能文件夹的绝对路径:带脚本 / 资料的技能要往那里放文件,模型得知道在哪。
 * 返回给模型的话一律英文(模型读的)。
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';
import { skillsDir, agentsDir, tanguHome, DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { slugify } from '../../agents/agentRegistry.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../../seams/runContext.js';
import { parseFrontmatter, isBuiltinSkillName, isUntouchedSeedMirror } from '../../skills/localSkills.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** scope='agent' → 当前激活 agent 的私有技能目录(agents/<slug>/skills,只在该 agent 激活时装载,
 *  优先级盖过同 id 用户级;/refine 沉淀「这个 agent 的流程」走这里);缺省 'user' = 全 agent 共享。
 *  展示身份优先:localSkills 装载用 currentDisplayAgentSlug,写入必须同桶(Codex 评审 #3)。 */
const scopeAgentSlug = () => currentDisplayAgentSlug() || currentAgentSlug() || DEFAULT_AGENT_SLUG;
const skillsRoot = (scope: string) => (scope === 'agent' ? path.join(agentsDir(), scopeAgentSlug(), 'skills') : skillsDir());
const skillMdPath = (root: string, slug: string) => path.join(root, slug, 'SKILL.md');

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 本工具自己写的 frontmatter 键;其余的键在 update 时原样带过去。 */
const OWN_KEYS = new Set(['name', 'description', 'origin']);

/** 组装 SKILL.md:frontmatter(name + 可选 description + 沿用的其余键 + origin)+ 正文。frontmatter 值强制单行(解析器按行读)。
 *  `origin: agent` = 来源标识:这个工具只会被 agent 调用,create/update 一律打上(用户手写后被 agent 改过的也算「agent 动过」),
 *  localSkills.toRecord 透传成 SkillRecord.origin → 桌面技能列表打「自建」徽标。没有它,用户级自建技能与手写技能无从分辨(09-18 取证)。
 *  keep = update 时现有 frontmatter 里的其余键(shared 共享开关、version / icon / category / author、导入技能带的 license …):
 *  用户手写或导入的技能带着它们,重写时别静默抹掉。只认解析器读得出的单行键;嵌套结构(缩进的子键)本来就读不到。 */
function composeSkillMd(name: string, description: string, body: string, keep: Record<string, string> = {}): string {
  const lines = ['---', `name: ${oneLine(name)}`];
  const d = oneLine(description);
  if (d) lines.push(`description: ${d}`);
  for (const [k, v] of Object.entries(keep)) if (!OWN_KEYS.has(k) && oneLine(v)) lines.push(`${k}: ${oneLine(v)}`);
  lines.push('origin: agent', '---', '', String(body ?? '').trim(), '');
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
            'scope: "user" (default) = shared across all agents; "agent" = private to the currently active agent (loads only when it is active; use for lessons specific to this agent\'s role, e.g. from a /refine round). ' +
            'A skill may bundle helper scripts or reference files: create it first, then write them into the skill folder this tool returns and refer to them by relative path in the instructions. ' +
            'For anything beyond a short how-to — bundled scripts, a description that has to trigger reliably, improving an existing skill — load the skill-creator skill first (use_skill, id "local:skill-creator") and follow it. ' +
            'Name at the CLASS level (e.g. "deploy-forsion-web"), never a one-off ("fix-bug-today"). Do NOT capture environment failures, "tool X is broken" claims, or transient errors — they harden into refusals that bite you later. ' +
            'action ∈ create | update | delete | list. create needs name + instructions; update needs slug + instructions. Built-in skills are read-only.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'update', 'delete', 'list'], description: 'The operation' },
              scope: { type: 'string', enum: ['user', 'agent'], description: 'Where the skill lives: "user" (default, all agents) or "agent" (private to the currently active agent)' },
              slug: { type: 'string', description: 'Unique skill id (lowercase alphanumerics and hyphens); required for update/delete, and for create when the name is not plain ASCII (otherwise derived from name)' },
              name: { type: 'string', description: 'Display name (required for create)' },
              description: { type: 'string', description: 'One-sentence summary shown in the skill catalog so future-you knows when to load it (recommended)' },
              instructions: { type: 'string', description: 'The SKILL.md body — the actual step-by-step how-to (required for create/update)' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        const action = String(args.action || '');
        // 远程污点 run 只许 list(P0 第三轮 E5):技能下一次本机 run 就会被 use_skill 装载。
        const remoteDenied = effectiveRemote(ctx) ? remoteManagementDenied('manage_skill', args.action) : null;
        if (remoteDenied) return `Error: ${remoteDenied}`;
        const scope = args.scope === 'agent' ? 'agent' : 'user';
        const root = skillsRoot(scope);
        const scopeTag = scope === 'agent' ? ' (agent scope)' : '';
        try {
          if (action === 'list') {
            // list 缺省两个作用域都列([agent] 打标);显式给了 scope 就只列那个(Codex 评审 #11)。
            const listRoots: ReadonlyArray<readonly [string, string]> =
              args.scope === 'agent' ? [[skillsRoot('agent'), ' [agent]']]
              : args.scope === 'user' ? [[skillsDir(), '']]
              : [[skillsDir(), ''], [skillsRoot('agent'), ' [agent]']];
            const rows: string[] = [];
            for (const [r, tag] of listRoots) {
              let names: string[];
              try {
                names = (await fs.readdir(r, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
              } catch {
                continue;
              }
              for (const slug of names.sort()) {
                if (!(await fileExists(skillMdPath(r, slug)))) continue;
                const { meta } = parseFrontmatter(await fs.readFile(skillMdPath(r, slug), 'utf-8').catch(() => ''));
                const builtin = !tag && (await isBuiltinSkillName(slug));
                rows.push(`- ${slug}: ${meta.name || slug}${meta.description ? ` — ${meta.description}` : ''}${builtin ? ' [built-in, read-only]' : ''}${tag}`);
              }
            }
            return rows.length ? rows.join('\n') : '(no user skills yet)';
          }

          if (action === 'delete') {
            const slug = oneLine(args.slug);
            if (!SAFE_SLUG.test(slug)) return 'Error: delete needs a valid slug (lowercase letters, digits, hyphens)';
            if (await isBuiltinSkillName(slug)) return `Error: "${slug}" is a built-in skill and cannot be deleted`;
            if (await isUntouchedSeedMirror(path.join(root, slug))) return `Error: "${slug}" is a read-only skill shipped with the app; it cannot be deleted`;
            if (!(await fileExists(skillMdPath(root, slug)))) return `Skill not found: ${slug}${scopeTag}`;
            // 整个文件夹移进回收目录(与设置页删技能同一处、同一命名,见 skills/catalog.deleteCatalogSkill),不直接删:
            // 技能里可能带着脚本和资料,模型删错了还找得回来。挪不动(比如跨盘)就报错、原样留着。
            const trash = path.join(tanguHome(), 'skill-trash');
            await fs.mkdir(trash, { recursive: true });
            const backup = path.join(trash, `${scope}-${scope === 'agent' ? scopeAgentSlug() : 'global'}-${slug}-${Date.now()}-${randomUUID()}`);
            await fs.rename(path.join(root, slug), backup);
            return `Deleted skill "${slug}"${scopeTag}. Its folder was moved to ${backup} (move it back to restore).`;
          }

          if (action === 'create' || action === 'update') {
            const body = String(args.instructions ?? '');
            if (!body.trim()) return 'Error: create/update needs instructions (the skill body)';

            let slug: string;
            if (action === 'create') {
              if (!args.name) return 'Error: create needs name';
              // slugify 只留拉丁字母和数字:纯中文名推不出东西(一律落到同一个兜底值),中英混合的名字只剩下零碎
              // (「CSV 排序去重」→ "csv",10-05 真模型实测)。名字里有别的文字时让模型自己给一个说得清的 slug。
              if (!args.slug && /[^\x00-\x7f]/.test(String(args.name))) return `Error: cannot derive a clear slug from the name "${oneLine(args.name)}"; pass slug as well (lowercase letters, digits, hyphens — e.g. "weekly-report")`;
              slug = args.slug ? oneLine(args.slug) : slugify(String(args.name));
              if (!SAFE_SLUG.test(slug)) return `Error: invalid slug: ${slug} (lowercase letters, digits, hyphens)`;
              if (await isBuiltinSkillName(slug)) return `Error: "${slug}" is the name of a built-in skill (protected); pick another name`;
              if (await fileExists(skillMdPath(root, slug))) return `Error: skill "${slug}" already exists${scopeTag}; use action="update" to change it`;
            } else {
              slug = oneLine(args.slug);
              if (!SAFE_SLUG.test(slug)) return 'Error: update needs a valid slug';
              if (await isBuiltinSkillName(slug)) return `Error: "${slug}" is a built-in skill and cannot be changed; create your own skill under another name`;
              if (await isUntouchedSeedMirror(path.join(root, slug))) return `Error: "${slug}" is a read-only skill shipped with the app; create your own skill under another name`;
              if (!(await fileExists(skillMdPath(root, slug)))) return `Error: skill to update not found: ${slug}${scopeTag} (skills marked [agent] in the list need scope:"agent"; create and update must use the same scope)`;
            }

            // name/description:create 用给定值;update 缺省沿用现有 frontmatter(免得每次都重报)。
            let name = args.name != null ? String(args.name) : '';
            let description = args.description != null ? String(args.description) : '';
            let keep: Record<string, string> = {};
            if (action === 'update') {
              const prev = parseFrontmatter(await fs.readFile(skillMdPath(root, slug), 'utf-8').catch(() => '')).meta;
              if (!name) name = prev.name || slug;
              if (args.description == null) description = prev.description || '';
              keep = prev;
            }

            const dir = path.join(root, slug);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(skillMdPath(root, slug), composeSkillMd(name || slug, description, body, keep), 'utf-8');
            return action === 'create'
              ? `Created skill "${slug}" (${oneLine(name) || slug})${scopeTag} in ${dir}. It is listed under Available Skills from the next message on (id: local:${slug}); ` +
                'an agent that runs on a hand-picked skill list only gets it once the user ticks it there. ' +
                'Helper scripts and reference files go in that folder; refer to them by relative path in the instructions.'
              : `Updated skill "${slug}" (${oneLine(name) || slug})${scopeTag} in ${dir}.`;
          }

          return `Error: unknown action: ${action}`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
