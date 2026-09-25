import { useEffect, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { theme } from '../theme.js';
import { L } from '../i18n.js';
import { APPROVAL_MODE_META, type ApprovalModeId } from '../../core/commandCatalog.js';
import type { RunStatus, ApprovalMode } from '../types.js';

// 单行方形加载(braille 点阵旋转 spinner),黑白灰单色。
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner(active: boolean): string {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 90);
    return () => clearInterval(t);
  }, [active]);
  return active ? FRAMES[f] : '●';
}

function shortCwd(cwd: string): string {
  const home = homedir();
  let p = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const segs = p.split('/');
  if (p.length > 30 && segs.length > 3) p = '…/' + segs.slice(-2).join('/');
  return p;
}

/** 审批档的界面名(APPROVAL_MODE_META 单源,与 Desktop 药丸同名);未知值原样显示。 */
export function approvalLabel(mode: string): string {
  const meta = APPROVAL_MODE_META[mode as ApprovalModeId];
  return meta ? L(meta.zh, meta.en) : mode;
}

/**
 * 思考档显示:请求档,若本模型实际按别的档跑 → `请求→生效`。
 * effective 来自引擎 context_info(权威)或模型目录的能力表估算(还没跑过 run 时)。
 */
export function thinkingLabel(requested: string, effective?: string): string {
  return effective && effective !== requested ? `${requested}→${effective}` : requested;
}

/**
 * 底部状态栏(单行,超宽从尾部截断):spinner · model · 思考档 · 审批档 · [计划] · [@agent] · 运行态 · token/ctx · cwd。
 * 重要的放前面 —— 窄终端截掉的是 cwd 与用量,不是模型与档位。
 */
export function StatusBar({
  model,
  cwd,
  execMode,
  approvalMode,
  status,
  tokens,
  ctxPct,
  busy,
  thinking,
  planMode,
  agentSlug,
  queued,
}: {
  model: string;
  cwd: string;
  execMode: string;
  approvalMode: ApprovalMode;
  status: RunStatus;
  tokens: number;
  ctxPct?: number;
  busy: boolean;
  /** 已格式化的思考档(见 thinkingLabel)。 */
  thinking: string;
  planMode?: boolean;
  agentSlug?: string;
  /** 待注入 / 待发送的排队消息数。 */
  queued?: number;
}): ReactElement {
  const spin = useSpinner(busy);
  const phase = status.phase ? ` ${status.phase}` : '';
  const stateText = busy ? `${status.state}${status.iteration ? ` ·${L(`第${status.iteration + 1}轮`, `step ${status.iteration + 1}`)}` : ''}${phase}` : 'idle';
  const ctx = typeof ctxPct === 'number' && ctxPct > 0 ? ` · ctx ${Math.min(100, Math.round(ctxPct))}%` : '';
  const sep = <Text color={theme.dim}> · </Text>;
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={busy ? 'white' : theme.dim}>{spin} </Text>
        <Text color={model ? theme.dim : theme.warn}>{model || L('⚠ 无模型(/model)', '⚠ no model (/model)')}</Text>
        {sep}
        <Text color={theme.dim}>{`${L('思考', 'think')} ${thinking}`}</Text>
        {sep}
        <Text color={approvalMode === 'full-auto' ? 'magenta' : theme.dim}>{approvalLabel(approvalMode)}</Text>
        {planMode ? (
          <>
            {sep}
            <Text color={theme.accent}>{L('📋 计划模式', '📋 plan')}</Text>
          </>
        ) : null}
        {agentSlug ? (
          <>
            {sep}
            <Text color={theme.dim}>{`@${agentSlug}`}</Text>
          </>
        ) : null}
        {queued ? (
          <>
            {sep}
            <Text color={theme.warn}>{L(`排队 ${queued}`, `${queued} queued`)}</Text>
          </>
        ) : null}
        <Text color={theme.dim}>
          {` · ${stateText} · ⛁ ${tokens.toLocaleString()} tok${ctx} · ${execMode === 'host' ? shortCwd(cwd) : 'sandbox'}`}
        </Text>
      </Text>
    </Box>
  );
}
