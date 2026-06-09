import { type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Markdown } from './Markdown.js';
import { ToolCard } from './ToolCard.js';
import type { Block, TranscriptItem } from '../types.js';

function BlockView({ block, markdown }: { block: Block; markdown: boolean }): ReactElement | null {
  if (block.type === 'tool') return <ToolCard block={block} />;
  if (block.type === 'reasoning') {
    const t = block.text.trim();
    if (!t) return null;
    // 已定稿(进 <Static>，markdown=true)→折叠成一行摘要(像 claude code 的「✻ 思考」)；
    // 流式中(markdown=false)→展开 dim 全文，让用户实时看到思考过程。
    if (markdown) {
      const lines = t.split('\n').filter((l) => l.trim()).length;
      return (
        <Text color={theme.reasoning} dimColor>
          {`✻ 思考 · ${t.length} 字${lines > 1 ? ` · ${lines} 段` : ''}（已折叠）`}
        </Text>
      );
    }
    return (
      <Text color={theme.reasoning} dimColor>
        ✻ 思考中…{'\n'}
        {t}
      </Text>
    );
  }
  if (!block.text) return null;
  return markdown ? <Markdown text={block.text} /> : <Text color={theme.assistant}>{block.text}</Text>;
}

/** 顺序渲染一个 assistant 回合的块（markdown=true 用于已定稿项，false 用于流式中纯文本）。 */
export function Blocks({ blocks, markdown }: { blocks: Block[]; markdown: boolean }): ReactElement {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} markdown={markdown} />
      ))}
    </Box>
  );
}

function UserMessage({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.user} bold>
        {'› '}
      </Text>
      <Text color={theme.user}>{text}</Text>
    </Box>
  );
}

function Notice({ text, tone }: { text: string; tone: string }): ReactElement {
  const color =
    tone === 'error' ? theme.error : tone === 'success' ? theme.success : tone === 'warn' ? theme.warn : theme.dim;
  return (
    <Box marginTop={1}>
      <Text color={color}>{text}</Text>
    </Box>
  );
}

/** Static 里渲染一条已定稿项（assistant 走 markdown）。 */
export function ItemView({ item }: { item: TranscriptItem }): ReactElement {
  if (item.kind === 'user') return <UserMessage text={item.text} />;
  if (item.kind === 'notice') return <Notice text={item.text} tone={item.tone} />;
  return (
    <Box marginTop={1} flexDirection="column">
      <Blocks blocks={item.blocks} markdown />
    </Box>
  );
}

/** 流式中的 live 区：assistant 文本用纯文本（高频更新，避免每 token 重解析 markdown）。 */
export function LiveView({ blocks }: { blocks: Block[] }): ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Blocks blocks={blocks} markdown={false} />
    </Box>
  );
}
