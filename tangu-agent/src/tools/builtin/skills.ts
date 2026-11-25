/**
 * 技能工具:use_skill + 云端文档技能速查表(从 registry.ts 原样搬移)。
 * use_skill 的「无启用技能时不暴露给 LLM」过滤仍在 registry.getToolDefinitions(语义:
 * 不暴露但可执行,返回 session 级提示),不放 isEnabledFor(后者会让 executeTool 也查不到)。
 */
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';

import { stageSessionSkill } from '../../sandbox/sessionSandbox.js';

const USE_SKILL_MAX_CHARS = 120_000;

// 云端纯 Python 沙箱的文档技能「精简速查表」：覆盖 docx/xlsx/pptx/pdf。
// 这些技能的官方正文是给 docx-js/pandoc/OOXML 写的（10万+字），会把模型带成生成超长 verbose 代码、
// 每步 8000+ token、几分钟。这里改喂极简 python 库用法，生成量降一个数量级。
// 只给云端目录里的那几个文档技能(见 cloudDocCheatsheet):`names` 是整串比对的技能名 / id,不是子串。
const CLOUD_SKILL_CHEATSHEETS: Array<{ names: readonly string[]; title: string; body: string }> = [
  {
    names: ['docx', 'word'],
    title: 'docx (use python-docx, cloud Python sandbox)',
    body: [
      'Use python-docx to write the .docx in one step and save it to the current directory (it flows back to the workspace).',
      'Do not hand-craft OOXML/XML, do not use docx-js/pandoc, and do not write an intermediate file then convert.',
      '',
      'from docx import Document',
      'from docx.shared import Pt, Inches',
      'doc = Document()',
      "doc.add_heading('Title', level=0)",
      "doc.add_heading('Heading 1', level=1)",
      "doc.add_paragraph('A body paragraph.')",
      "r = doc.add_paragraph().add_run('bold'); r.bold = True",
      "doc.add_paragraph('Item 1', style='List Bullet')",
      "t = doc.add_table(rows=2, cols=3); t.style = 'Table Grid'; t.cell(0,0).text = 'Header'",
      "# doc.add_picture('img.png', width=Inches(4)); doc.add_page_break()",
      "doc.save('output.docx')",
      '',
      'Produce the length the user asked for; do not pad needlessly. Write the full script in one run_python.',
    ].join('\n'),
  },
  {
    names: ['xlsx', 'excel', 'spreadsheet'],
    title: 'xlsx (use openpyxl, cloud Python sandbox)',
    body: [
      'Use openpyxl to write the .xlsx (for large data, use pandas df.to_excel).',
      '',
      'from openpyxl import Workbook',
      'from openpyxl.styles import Font',
      "wb = Workbook(); ws = wb.active; ws.title = 'Sheet1'",
      "ws.append(['Name', 'Score']); ws['A1'].font = Font(bold=True)",
      "ws.append(['Alice', 95]); ws.column_dimensions['A'].width = 20",
      "wb.save('output.xlsx')",
    ].join('\n'),
  },
  {
    names: ['pptx', 'powerpoint', 'presentation', 'ppt'],
    title: 'pptx (use python-pptx, cloud Python sandbox)',
    body: [
      'Use python-pptx to write the .pptx.',
      '',
      'from pptx import Presentation',
      'prs = Presentation()',
      's = prs.slides.add_slide(prs.slide_layouts[0])',
      "s.shapes.title.text = 'Title'; s.placeholders[1].text = 'Subtitle'",
      's2 = prs.slides.add_slide(prs.slide_layouts[1])',
      "s2.shapes.title.text = 'Key points'; s2.placeholders[1].text = 'Point one\\nPoint two'",
      "prs.save('output.pptx')",
    ].join('\n'),
  },
  {
    names: ['pdf'],
    title: 'pdf (use reportlab, cloud Python sandbox)',
    body: [
      'Use reportlab to write the .pdf (for CJK text, use the built-in CID font STSong-Light).',
      '',
      'from reportlab.lib.pagesizes import A4',
      'from reportlab.lib.styles import getSampleStyleSheet',
      'from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer',
      'from reportlab.pdfbase import pdfmetrics',
      'from reportlab.pdfbase.cidfonts import UnicodeCIDFont',
      "pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))",
      'ss = getSampleStyleSheet()',
      "for n in ('Normal','Title','Heading1'): ss[n].fontName = 'STSong-Light'",
      "doc = SimpleDocTemplate('output.pdf', pagesize=A4)",
      "doc.build([Paragraph('Title', ss['Title']), Spacer(1, 12), Paragraph('Body text.', ss['Normal'])])",
    ].join('\n'),
  },
];

/**
 * 速查表只替换云端目录里那几个文档技能(管理员上传的官方 docx / xlsx / pptx / pdf)的正文。
 * 先认来源:本地技能(`local:`,含插件技能 `local:plugin/…` 与本机导入的同名技能)、用户自己上传的
 * (`usr_*` / 带 owner_user_id)都不是,一律给它自己的正文。再认名字:技能名或去掉 `<appId>:` 前缀的 id
 * 整串等于 `names` 之一才算。曾按子串匹配(/docx|word/i 之类),名字里带 word / presentation 的技能
 * (如 word-count、presentation-notes)拿到的是速查表,不是它自己的 SKILL.md。
 */
function cloudDocCheatsheet(id: string, s: { name?: unknown; owner_user_id?: unknown; source?: unknown }) {
  if (id.startsWith('local:') || id.startsWith('usr_')) return undefined;
  if (s.owner_user_id || (s.source != null && s.source !== 'cloud')) return undefined;
  const byKey = (k: string) => CLOUD_SKILL_CHEATSHEETS.find((c) => c.names.includes(k.trim().toLowerCase()));
  return byKey(String(s.name ?? '')) ?? byKey(id.replace(/^[^:]*:/, '')); // 名字优先;名字对不上再看 id
}

export const skillsProvider: ToolProvider = {
  id: 'builtin:skills',
  tools: () => [
    {
      name: 'use_skill',
      capabilities: { outputKind: 'instructions' },
      definition: {
        type: 'function',
        function: {
          name: 'use_skill',
          description:
            'Load the full manual (SKILL.md) of an available skill on demand. When a task matches a skill listed in the system prompt, ' +
            'first call this tool with its id to get the complete instructions, then execute accordingly.',
          parameters: {
            type: 'object',
            properties: { skill_id: { type: 'string', description: 'Skill id (see the Available Skills list)' } },
            required: ['skill_id'],
          },
        },
      },
      execute: async (args, ctx) => {
        let id = String(args.skill_id ?? '').trim();
        if (!id) return 'Error: skill_id is required';
        // 模型常把本地技能的 id 写成不带前缀的名字(目录里是 `local:skill-creator`,它传 `skill-creator`;10-05 真模型实测):
        // 原样不在准许清单、补上前缀就在 → 按补上的认。只在准许清单里找,不会因此多放行任何技能。
        if (ctx.enabledSkillIds && !ctx.enabledSkillIds.includes(id) && ctx.enabledSkillIds.includes(`local:${id}`)) id = `local:${id}`;
        if (!ctx.enabledSkillIds || !ctx.enabledSkillIds.includes(id)) {
          return `Skill "${id}" is not available in this session.`;
        }
        const s = await deps().brain.assets.getSkill(id, ctx.userId);
        if (!s) return `Skill "${id}" not found.`;
        if (id.startsWith('usr_gh_')) {
          if (ctx.execMode !== 'sandbox') return 'This cloud skill package is available in cloud sandbox sessions.';
          const load = deps().brain.assets.getSkillPackage;
          if (!load) return 'Error: this backend cannot load cloud skill packages.';
          const folder = await stageSessionSkill(ctx, id, () => load(ctx.userId, id), ctx.signal);
          return `# Skill: ${s.name}\n\nSkill folder in the Python sandbox: /workspace/${folder}\nResolve scripts and references relative to this folder.\n\n${s.content?.slice(0, USE_SKILL_MAX_CHARS)}`;
        }
        // 云端目录里的文档技能：用精简 python 库速查表替代官方 docx-js/OOXML 长正文（生成量降一个数量级）。
        const cheat = cloudDocCheatsheet(id, s as { name?: unknown; owner_user_id?: unknown; source?: unknown });
        if (cheat) return `# Skill: ${cheat.title}\n\n${cheat.body}`;
        const body = (s.content && String(s.content).trim()) || (s.description && String(s.description).trim()) || '';
        if (!body) return `Skill "${s.name}" has no instructions.`;
        // 技能自带的文件(scripts/ references/ assets/)在正文里写的是相对路径:把文件夹告诉模型,它才找得到。
        // 只对本机会话里的本地技能给:云端技能没有文件夹,沙箱里也够不着这个路径。
        const dir = ctx.execMode === 'host' ? String((s as { dir?: string }).dir || '') : '';
        const head = `# Skill: ${s.name}\n\n` + (dir ? `Skill folder: ${dir}\nRelative paths in this skill (scripts/, references/, assets/ …) resolve against that folder.\n\n` : '');
        return head + body.slice(0, USE_SKILL_MAX_CHARS) + (body.length > USE_SKILL_MAX_CHARS ? '\n\n…(truncated)' : '');
      },
    },
  ],
};
