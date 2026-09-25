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
  /** 'diff' = 按行上色(+ 绿 / - 红 / @@ 青),/diff 用。 */
  variant?: 'diff';
}
export type TranscriptItem = UserItem | AssistantItem | NoticeItem;

/** 会话 todo 清单项（todo_write 工具发的 `todo` 事件载荷;形状与 builtin/todo.ts 一致,这里复刻避免 tui→tools 耦合）。 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | 'custom';

export interface PendingApproval {
  approvalId: string;
  name: string;
  args: string;
  preview: string;
  /** 引擎的「为什么问你」(approval_request.reason.kind,白名单清洗过)。escalate / custom-ask / control 不吃「总允许」。 */
  reasonKind?: 'custom-ask' | 'escalate' | 'mode' | 'control';
}

/** ask_user / exit_plan_mode 的待答询问(机制同审批,answer 为自由文本)。 */
export interface PendingInquiry {
  inquiryId: string;
  question: string;
  options: string[];
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
  usage: { total: number; cost: number; cached: number; lastPrompt: number };
  approval: PendingApproval | null;
  inquiry: PendingInquiry | null;
  /** 当前会话 todo 清单（todo 事件实时刷新;常驻面板渲染）。 */
  todos: TodoItem[];
}

export type UiAction =
  | { type: 'ADD_USER'; text: string }
  | { type: 'ADD_NOTICE'; text: string; tone?: NoticeItem['tone']; variant?: NoticeItem['variant'] }
  | { type: 'START_LIVE' }
  | { type: 'APPEND_TEXT'; delta: string }
  | { type: 'APPEND_REASONING'; delta: string }
  | { type: 'TOOL_CALL'; id: string; name: string; args: string }
  | { type: 'TOOL_RESULT'; id: string; name: string; result: string; isError: boolean }
  | { type: 'USAGE'; tokens: number; cost: number; cached: number; iteration: number; prompt: number }
  | { type: 'STATUS'; state?: RunStatus['state']; iteration?: number; phase?: string }
  | { type: 'APPROVAL'; approval: PendingApproval }
  | { type: 'APPROVAL_CLEAR' }
  | { type: 'INQUIRY'; inquiry: PendingInquiry }
  | { type: 'INQUIRY_CLEAR' }
  | { type: 'TODO'; todos: TodoItem[] }
  | { type: 'GROUP_NOTE'; text: string; tone?: NoticeItem['tone'] }
  /** 运行中插话被引擎注入(turn_boundary):封存已产出的助手气泡,再把插话作为用户气泡落在它后面。 */
  | { type: 'TURN_BOUNDARY'; userTexts: string[] }
  | { type: 'DONE' }
  | { type: 'ERROR'; msg: string; aborted?: boolean }
  | { type: 'CLEAR_ITEMS' }
  | { type: 'RESET_SESSION'; items?: TranscriptItem[] };
