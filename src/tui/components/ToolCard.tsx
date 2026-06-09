import { type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ToolBlock } from '../types.js';

function clip(s: string | undefined, n = 240): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 从工具参数里抽一句话预览（run_bash→命令，文件类→路径，其余→截断 JSON）。 */
function summarizeArgs(name: string, rawArgs: string): string {
  let args: any = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return clip(rawArgs, 80);
  }
  if (name === 'run_bash') return clip(args.command, 100);
  if (name === 'edit_file' || name === 'write_file' || name === 'read_file' || name === 'list_dir') return clip(args.path || args.command, 80);
  if (name === 'web_search') return clip(args.query, 80);
  if (name === 'use_skill') return clip(args.skill_id, 60);
  return clip(JSON.stringify(args), 80);
}

/** 工具调用卡片：⚙ 名称 + 参数预览，结果就绪后追加 ✓/✗ + 结果预览。 */
export function ToolCard({ block }: { block: ToolBlock }): ReactElement {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color={theme.tool}>⚙ {block.name}</Text>
        <Text color={theme.dim}>  {summarizeArgs(block.name, block.args)}</Text>
      </Text>
      {block.done ? (
        <Text color={block.isError ? theme.error : theme.dim}>
          {'  ↳ '}
          {block.isError ? '✗' : '✓'} {clip(block.result)}
        </Text>
      ) : (
        <Text color={theme.dim}>{'  ↳ …'}</Text>
      )}
    </Box>
  );
}
