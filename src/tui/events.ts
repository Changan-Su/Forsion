/** TUI 状态机：把 agent 事件流归约成可渲染的 transcript + 流式块 + 状态/用量/审批。 */
import type { UiState, UiAction, Block, TranscriptItem } from './types.js';

export const initialState: UiState = {
  items: [],
  nextId: 1,
  live: null,
  busy: false,
  status: { state: 'idle', iteration: 0 },
  usage: { total: 0, cost: 0, cached: 0, lastPrompt: 0 },
  approval: null,
  inquiry: null,
};

/** 取末块若为 text 则在其上追加，否则新开一个 text 块（不可变更新）。 */
function appendToText(blocks: Block[], delta: string): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    const next = blocks.slice(0, -1);
    next.push({ type: 'text', text: last.text + delta });
    return next;
  }
  return [...blocks, { type: 'text', text: delta }];
}

function appendToReasoning(blocks: Block[], delta: string): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'reasoning') {
    const next = blocks.slice(0, -1);
    next.push({ type: 'reasoning', text: last.text + delta });
    return next;
  }
  return [...blocks, { type: 'reasoning', text: delta }];
}

/** 把进行中的 live 块封装成一个已定稿的 assistant 项（若有内容）。 */
function flushLive(state: UiState): { items: TranscriptItem[]; nextId: number } {
  if (!state.live || !state.live.length) return { items: state.items, nextId: state.nextId };
  const item: TranscriptItem = { id: state.nextId, kind: 'assistant', blocks: state.live };
  return { items: [...state.items, item], nextId: state.nextId + 1 };
}

export function reducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'ADD_USER':
      return {
        ...state,
        items: [...state.items, { id: state.nextId, kind: 'user', text: action.text }],
        nextId: state.nextId + 1,
      };

    case 'ADD_NOTICE':
      return {
        ...state,
        items: [
          ...state.items,
          { id: state.nextId, kind: 'notice', text: action.text, tone: action.tone || 'info' },
        ],
        nextId: state.nextId + 1,
      };

    case 'START_LIVE':
      return { ...state, live: [], busy: true, status: { state: 'running', iteration: 0 } };

    case 'APPEND_TEXT':
      return { ...state, live: appendToText(state.live ?? [], action.delta) };

    case 'APPEND_REASONING':
      return { ...state, live: appendToReasoning(state.live ?? [], action.delta) };

    case 'TOOL_CALL':
      return {
        ...state,
        live: [
          ...(state.live ?? []),
          { type: 'tool', id: action.id, name: action.name, args: action.args, done: false },
        ],
      };

    case 'TOOL_RESULT': {
      if (!state.live) return state;
      return {
        ...state,
        live: state.live.map((b) =>
          b.type === 'tool' && b.id === action.id
            ? { ...b, result: action.result, isError: action.isError, done: true }
            : b,
        ),
      };
    }

    case 'USAGE':
      return {
        ...state,
        usage: { total: state.usage.total + action.tokens, cost: state.usage.cost + action.cost, cached: state.usage.cached + action.cached, lastPrompt: action.prompt || state.usage.lastPrompt },
        status: { ...state.status, iteration: action.iteration },
      };

    case 'STATUS':
      return {
        ...state,
        status: {
          state: action.state ?? state.status.state,
          iteration: action.iteration ?? state.status.iteration,
          phase: action.phase ?? state.status.phase,
        },
      };

    case 'APPROVAL':
      return { ...state, approval: action.approval };

    case 'APPROVAL_CLEAR':
      return { ...state, approval: null };

    case 'INQUIRY':
      return { ...state, inquiry: action.inquiry };

    case 'INQUIRY_CLEAR':
      return { ...state, inquiry: null };

    case 'DONE': {
      const { items, nextId } = flushLive(state);
      return {
        ...state,
        items,
        nextId,
        live: null,
        busy: false,
        approval: null,
        inquiry: null,
        status: { state: 'idle', iteration: 0 },
      };
    }

    case 'ERROR': {
      const flushed = flushLive(state);
      const tone = action.aborted ? 'warn' : 'error';
      const text = action.aborted ? '⏹ 已中止' : `✗ ${action.msg}`;
      return {
        ...state,
        items: [...flushed.items, { id: flushed.nextId, kind: 'notice', text, tone }],
        nextId: flushed.nextId + 1,
        live: null,
        busy: false,
        approval: null,
        inquiry: null,
        status: { state: 'idle', iteration: 0 },
      };
    }

    case 'CLEAR_ITEMS':
      return { ...state, items: [] };

    case 'RESET_SESSION':
      return {
        ...state,
        items: action.items ?? [],
        nextId: (action.items ?? []).reduce((m, it) => Math.max(m, it.id + 1), 1),
        live: null,
        busy: false,
        approval: null,
        inquiry: null,
        status: { state: 'idle', iteration: 0 },
      };

    default:
      return state;
  }
}
