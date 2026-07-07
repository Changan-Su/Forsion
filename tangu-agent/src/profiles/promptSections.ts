/**
 * 系统提示静态段(G4):从 agentLoop 内联文本**逐字节**搬移,按 AppProfile.promptSections 装载。
 * ⚠️ 改动这些文本会改变所有 app 的 prompt——per-app 定制请在各自 profile 工厂里覆盖,勿改默认段。
 */
import type { PromptSectionCtx, PromptSections } from '../seams/appProfile.js';
import { amadeusPromptSection, amadeusCloudPromptSection } from '../tools/builtin/amadeus.js';

/** 「记忆与日志」使用指引(用户记忆段之后、技能段之前)。 */
export const MEMORY_LOG_GUIDANCE =
  '## Memory & Logs\n' +
  '- When you encounter a user fact/preference worth keeping long-term, use the `remember` tool to store it in long-term memory (persists across sessions; do not store one-off details).\n' +
  '- Record completed work/conclusions/outputs to the current day\'s log with `log_event`; use `read_log` to review a specific day when you need history.';

/** host 模式(本地直连):真实文件系统 + shell 的执行环境说明。 */
export function hostEnvSection(cwd?: string): string {
  return (
    '## Local Execution Environment (important)\n' +
    `You are running on the **user's own machine**; the current working directory is \`${cwd || process.cwd()}\`.\n` +
    '- Use `run_bash` to run shell commands; `list_dir`/`read_file` to inspect; `edit_file` for precise local edits and `write_file` for new files — all act on the real filesystem (relative paths resolve against the current working directory).\n' +
    '- When a task involves existing files, or you are unsure what is in the working directory, call `list_dir` first instead of assuming it is empty.\n' +
    '- For live web information prefer `browser_search`; to open a page, click, type, or take a screenshot use `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_screenshot`.\n' +
    '- To change an existing file, edit only the affected lines — use `edit_file` (one region), `multi_edit` (several regions of one file), or `apply_patch`; do NOT re-read and re-emit a whole file for a small change (it wastes tokens and risks clobbering unrelated content). `read_file` output is cat -n (each line prefixed with its line number + a tab); strip that prefix so old_string matches the file\'s raw text.\n' +
    '- Destructive operations (writing files / running commands) may require user approval; when denied, switch approach or ask the user — do not retry the same operation repeatedly.'
  );
}

/** sandbox 模式:文件输出位置(最常见的「产物丢失」原因:模型把文件写到工作区之外)。 */
export const SANDBOX_OUTPUT_SECTION =
  '## File Output Location (important)\n' +
  'This session has a **workspace**, the only place that is preserved and returned to the user. ' +
  'When writing files with `write_file` or inside `run_python`, always use **relative paths** (e.g. `report.docx`, `out/data.csv`) — ' +
  'they land in the workspace (run_python\'s current directory is /workspace, equivalent to /mnt/data).\n' +
  '**Do not** write deliverables to `/tmp`, `~/` (HOME), or other absolute paths — those are outside the workspace, are not preserved, and the files will be lost.\n' +
  'The user may have uploaded files into this workspace. When a task involves existing files, or you are unsure what is present, call `list_files` first instead of assuming the workspace is empty.\n' +
  'To change part of an existing file, use `apply_patch` to edit only the affected lines rather than re-emitting the whole file with `write_file` (which wastes tokens and risks clobbering unrelated content). `read_file` output is cat -n (each line prefixed with its line number + a tab); strip that prefix so a patch\'s context/old lines match the raw text.';

/** sandbox 模式:执行效率约束(最影响耗时的是模型「生成量」:慢模型 ~50 tok/s,写 8000 token 要 ~160s)。 */
export const EFFICIENCY_SECTION =
  '## Execution Efficiency (important)\n' +
  '- To generate documents, use python-docx / openpyxl / python-pptx to **write the target file in one step**; ' +
  'do not write an intermediate md/txt and convert, do not generate the same content twice, do not hand-craft OOXML/XML, and do not use docx-js/pandoc/node.\n' +
  '- Produce exactly the length the user asked for; do not pad needlessly (the more you generate, the slower it is).\n' +
  '- In run_python, write the full script in one pass where possible to reduce round-trips.';

/** 默认段落装载(AI Studio 与 Tangu 当前文本一致;per-app 差异化在各自工厂覆盖)。 */
export function defaultPromptSections(ctx: PromptSectionCtx): PromptSections {
  return {
    guidance: [MEMORY_LOG_GUIDANCE],
    environment:
      ctx.execMode === 'host'
        ? // host 模式:本地环境段 + (若本机存在 Amadeus vault)笔记/日历指引
          [hostEnvSection(ctx.cwd), amadeusPromptSection()].filter((s): s is string => !!s)
        : // 非 host:沙箱段 + (若云端 amadeus facet 已装配,如 thin worker)云笔记库指引
          [SANDBOX_OUTPUT_SECTION, EFFICIENCY_SECTION, amadeusCloudPromptSection()].filter(
            (s): s is string => !!s,
          ),
  };
}
