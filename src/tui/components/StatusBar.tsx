import { useEffect, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { theme } from '../theme.js';
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

/** 底部状态栏：spinner · model · cwd/sandbox · 审批档 · token 用量 · 运行态。 */
export function StatusBar({
  model,
  cwd,
  execMode,
  approvalMode,
  status,
  tokens,
  busy,
}: {
  model: string;
  cwd: string;
  execMode: string;
  approvalMode: ApprovalMode;
  status: RunStatus;
  tokens: number;
  busy: boolean;
}): ReactElement {
  const spin = useSpinner(busy);
  const phase = status.phase ? ` ${status.phase}` : '';
  const stateText = busy ? `${status.state}${status.iteration ? ` ·第${status.iteration + 1}轮` : ''}${phase}` : 'idle';
  return (
    <Box marginTop={1}>
      <Text color={busy ? 'white' : theme.dim}>{spin} </Text>
      <Text color={theme.dim}>
        {model || '⚠ 无模型(/model)'} · {execMode === 'host' ? shortCwd(cwd) : 'sandbox'} · {approvalMode} · ⛁ {tokens.toLocaleString()} tok · {stateText}
      </Text>
    </Box>
  );
}
