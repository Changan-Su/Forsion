import { useMemo, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import type { PendingApproval } from '../types.js';
import type { ApprovalDecision } from '../../services/approvals.js';
import { L } from '../i18n.js';

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

type ReasonKind = NonNullable<PendingApproval['reasonKind']>;
const REASON_KINDS: readonly string[] = ['custom-ask', 'escalate', 'mode', 'control'];

/** approval_request.reason → kind 白名单(与桌面 appStore 同口径):不认识的 / 畸形的一律 undefined = 按旧行为显示。 */
export function approvalReasonKind(reason: unknown): ReasonKind | undefined {
  const k = reason && typeof reason === 'object' ? (reason as { kind?: unknown }).kind : undefined;
  return typeof k === 'string' && REASON_KINDS.includes(k) ? (k as ReasonKind) : undefined;
}

/** approval_request 事件载荷 → 弹窗状态(app.tsx 的唯一入口;reason 在这里白名单清洗)。 */
export function pendingApprovalFromEvent(p: any): PendingApproval {
  const reasonKind = approvalReasonKind(p?.reason);
  return {
    approvalId: p?.approvalId,
    name: p?.name,
    args: p?.arguments || '',
    preview: p?.preview || '',
    ...(reasonKind ? { reasonKind } : {}),
  };
}

/**
 * 引擎不会把这几类记进「总允许」(approvals.ts gateToolCall):越界写每次都确认;custom 的 ask 规则是用户写死的「永远问我」;
 * 控制面(设置 / 修改之后可无人值守运行的工作:自动化、auto 日程、建改 Agent)按了也只算批准一次。选项照显 = 界面说一套引擎做一套
 * → 藏掉 [A] 并说明为什么。控制面文案不写「完全放行」:manage_agent update 改的 agent 可能自带只读档,卡上预览会写「approval tier stays readonly」。
 */
function noAlwaysNote(kind: PendingApproval['reasonKind']): string {
  if (kind === 'control') return L('这会设置或修改之后可在你不在场时运行的工作，需要你逐次确认（不能总允许）', 'This sets up or changes work that can later run without you watching, so each call needs your confirmation (no "always allow")');
  if (kind === 'escalate') return L('要写工作区以外的文件，每次都要你确认（不能总允许）', 'This writes outside the workspace, so it needs your confirmation every time (no "always allow")');
  if (kind === 'custom-ask') return L('你的审批规则要求每次都问（不能总允许）', 'Your approval rules ask every time for this (no "always allow")');
  return '';
}

/** 审批弹窗：[a]同意 [A]总是(控制面 / 越界写 / ask 规则不给) [e]编辑(仅 run_bash) [n]拒绝；Ctrl+C 中止。 */
export function ApprovalPrompt({ approval, onDecision, onAbort }: ApprovalPromptProps): ReactElement {
  const args = useMemo(() => parseArgs(approval.args), [approval.args]);
  const editable = approval.name === 'run_bash';
  const note = noAlwaysNote(approval.reasonKind);
  const alwaysOk = !note;
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
    if (input === 'A' && alwaysOk) {
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
        {L('⚠ 需要审批 · ', '⚠ Approval needed · ')}
        {approval.name}
      </Text>
      <Text color={theme.dim}>{approval.preview}</Text>
      {note ? <Text color={theme.warn}>{note}</Text> : null}
      {editing ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>{L('编辑命令 › ', 'Edit command › ')}</Text>
          <Text>{editValue}</Text>
          <Text inverse> </Text>
          <Text color={theme.dim}>{L(' （Enter 确认执行 · Esc 取消编辑）', ' (Enter to run · Esc to cancel editing)')}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.success}>[a]</Text>
          <Text color={theme.dim}>{L('同意 ', 'approve ')}</Text>
          {alwaysOk ? (
            <>
              <Text color={theme.success}>[A]</Text>
              <Text color={theme.dim}>{L('本会话总允许 ', 'always allow this session ')}</Text>
            </>
          ) : null}
          {editable ? (
            <>
              <Text color={theme.accent}>[e]</Text>
              <Text color={theme.dim}>{L('编辑 ', 'edit ')}</Text>
            </>
          ) : null}
          <Text color={theme.error}>[n]</Text>
          <Text color={theme.dim}>{L('拒绝 · Ctrl+C 中止', 'reject · Ctrl+C abort')}</Text>
        </Box>
      )}
    </Box>
  );
}
