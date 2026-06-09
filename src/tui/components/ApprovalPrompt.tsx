import { useMemo, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import type { PendingApproval } from '../types.js';
import type { ApprovalDecision } from '../../services/approvals.js';

export interface ApprovalPromptProps {
  approval: PendingApproval;
  onDecision: (d: ApprovalDecision) => void;
  onAbort: () => void;
}

function parseArgs(raw: string): Record<string, any> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** 审批弹窗：[a]同意 [A]总是 [e]编辑(仅 run_bash) [n]拒绝；Ctrl+C 中止。 */
export function ApprovalPrompt({ approval, onDecision, onAbort }: ApprovalPromptProps): ReactElement {
  const args = useMemo(() => parseArgs(approval.args), [approval.args]);
  const editable = approval.name === 'run_bash';
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  useInput((input, key) => {
    if (editing) {
      if (key.return) {
        onDecision({ action: 'approve', argsOverride: { ...args, command: editValue } });
        return;
      }
      if (key.escape) {
        setEditing(false);
        return;
      }
      if (key.backspace || key.delete) {
        setEditValue((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setEditValue((v) => v + input);
      return;
    }
    if (key.ctrl && input === 'c') {
      onAbort();
      return;
    }
    if (input === 'a') {
      onDecision({ action: 'approve' });
      return;
    }
    if (input === 'A') {
      onDecision({ action: 'approve_always' });
      return;
    }
    if (input === 'e' && editable) {
      setEditValue(String(args.command ?? ''));
      setEditing(true);
      return;
    }
    if (input === 'n' || key.escape) {
      onDecision({ action: 'reject' });
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn} bold>
        ⚠ 需要审批 · {approval.name}
      </Text>
      <Text color={theme.dim}>{approval.preview}</Text>
      {editing ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>{'编辑命令 › '}</Text>
          <Text>{editValue}</Text>
          <Text inverse> </Text>
          <Text color={theme.dim}> （Enter 确认执行 · Esc 取消编辑）</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.success}>[a]</Text>
          <Text color={theme.dim}>同意 </Text>
          <Text color={theme.success}>[A]</Text>
          <Text color={theme.dim}>本会话总允许 </Text>
          {editable ? (
            <>
              <Text color={theme.accent}>[e]</Text>
              <Text color={theme.dim}>编辑 </Text>
            </>
          ) : null}
          <Text color={theme.error}>[n]</Text>
          <Text color={theme.dim}>拒绝 · Ctrl+C 中止</Text>
        </Box>
      )}
    </Box>
  );
}
