/** TUI 共享类型：transcript 项、流式块、reducer 状态/动作。 */

// ── 流式中的「块」：一个 assistant 回合由若干文本/推理/工具块按时间顺序组成 ──
export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}
export interface ToolBlock {
  type: 'tool';
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  done: boolean;
}
export type Block = TextBlock | ReasoningBlock | ToolBlock;

// ── 已定稿的 transcript 项（进 <Static>，只渲染一次）──
export interface UserItem {
  id: number;
  kind: 'user';
  text: string;
}
export interface AssistantItem {
  id: number;
  kind: 'assistant';
  blocks: Block[];
}
export interface NoticeItem {
  id: number;
  kind: 'notice';
  text: string;
  tone: 'info' | 'error' | 'success' | 'warn';
}
export type TranscriptItem = UserItem | AssistantItem | NoticeItem;

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto';

export interface PendingApproval {
  approvalId: string;
  name: string;
  args: string;
  preview: string;
}

export interface RunStatus {
  state: 'idle' | 'queued' | 'running' | 'generating';
  iteration: number;
  phase?: string;
}

export interface UiState {
  items: TranscriptItem[];
  nextId: number;
  live: Block[] | null; // 进行中的 assistant 回合块序列；null=无活跃回合
  busy: boolean;
  status: RunStatus;
  usage: { total: number; cost: number; cached: number };
  approval: PendingApproval | null;
}

export type UiAction =
  | { type: 'ADD_USER'; text: string }
  | { type: 'ADD_NOTICE'; text: string; tone?: NoticeItem['tone'] }
  | { type: 'START_LIVE' }
  | { type: 'APPEND_TEXT'; delta: string }
  | { type: 'APPEND_REASONING'; delta: string }
  | { type: 'TOOL_CALL'; id: string; name: string; args: string }
  | { type: 'TOOL_STREAM'; id: string; delta: string }
  | { type: 'TOOL_RESULT'; id: string; name: string; result: string; isError: boolean }
  | { type: 'USAGE'; tokens: number; cost: number; cached: number; iteration: number }
  | { type: 'STATUS'; state?: RunStatus['state']; iteration?: number; phase?: string }
  | { type: 'APPROVAL'; approval: PendingApproval }
  | { type: 'APPROVAL_CLEAR' }
  | { type: 'DONE' }
  | { type: 'ERROR'; msg: string; aborted?: boolean }
  | { type: 'CLEAR_ITEMS' }
  | { type: 'RESET_SESSION'; items?: TranscriptItem[] };
