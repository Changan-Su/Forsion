import { useMemo, type ReactElement } from 'react';
import { Text } from 'ink';
import { renderMarkdown } from '../markdown.js';

/** 把 markdown 文本渲染成带 ANSI 的终端文本（Ink <Text> 会原样输出内嵌 ANSI）。 */
export function Markdown({ text }: { text: string }): ReactElement {
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  return <Text>{rendered}</Text>;
}
