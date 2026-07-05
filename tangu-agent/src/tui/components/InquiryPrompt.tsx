/** 询问弹窗(ask_user / exit_plan_mode):数字键选选项,直接打字自由回答,Enter 提交;Ctrl+C 中止。 */
import { useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import type { PendingInquiry } from '../types.js';

export interface InquiryPromptProps {
  inquiry: PendingInquiry;
  onAnswer: (answer: string) => void;
  onAbort: () => void;
}

export function InquiryPrompt({ inquiry, onAnswer, onAbort }: InquiryPromptProps): ReactElement {
  const [draft, setDraft] = useState('');

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAbort();
      return;
    }
    if (key.return) {
      if (draft.trim()) onAnswer(draft.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((v) => v.slice(0, -1));
      return;
    }
    // 草稿为空时数字键直选选项;已开始打字则数字进入草稿
    if (!draft && /^[1-9]$/.test(input)) {
      const idx = Number(input) - 1;
      if (idx < inquiry.options.length) {
        onAnswer(inquiry.options[idx]);
        return;
      }
    }
    if (input && !key.ctrl && !key.meta) setDraft((v) => v + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        ❓ {inquiry.question}
      </Text>
      {inquiry.options.map((opt, i) => (
        <Text key={i} color={theme.dim}>
          {'  '}[{i + 1}] {opt}
        </Text>
      ))}
      <Box marginTop={inquiry.options.length ? 1 : 0}>
        <Text color={theme.accent}>{'回答 › '}</Text>
        <Text>{draft}</Text>
        <Text inverse> </Text>
        <Text color={theme.dim}>
          {inquiry.options.length ? ' （数字键选选项 / 直接输入,Enter 提交）' : ' （输入后 Enter 提交）'}
        </Text>
      </Box>
    </Box>
  );
}
