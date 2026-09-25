import { useMemo, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { matchCommands, completeFilePath } from '../commands.js';
import { inputHistory } from '../history.js';
import { L } from '../i18n.js';

export interface Suggestion {
  label: string;
  desc: string;
  insert: string;
}

interface WordInfo {
  start: number;
  end: number;
  prefix: string;
}

/** 光标所在「词」（空白分隔）的边界与已输入前缀（到光标处）。 */
function wordAt(value: string, cursor: number): WordInfo {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { start, end, prefix: value.slice(start, cursor) };
}

function longestCommonPrefix(strs: string[]): string {
  if (!strs.length) return '';
  let p = strs[0];
  for (const s of strs) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}

function computeSuggestions(value: string, cursor: number, cwd: string): Suggestion[] {
  const { start, prefix } = wordAt(value, cursor);
  if (start === 0 && prefix.startsWith('/')) {
    return matchCommands(prefix).map((c) => ({ label: c.name, desc: c.desc, insert: c.name }));
  }
  if (prefix.startsWith('@')) {
    return completeFilePath(cwd, prefix.slice(1)).map((f) => ({ label: '@' + f, desc: '', insert: '@' + f }));
  }
  return [];
}

export interface InputBoxProps {
  busy: boolean;
  cwd: string;
  /** false = 让出键盘(审批 / 询问 / 选择器在前台);组件保持挂载,草稿不丢。 */
  active?: boolean;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onExit: () => void;
  /** Shift+Tab:循环思考档。 */
  onCycleThinking?: () => void;
  /** Ctrl+P:打开模型选择器。 */
  onOpenModelPicker?: () => void;
}

/**
 * 输入框：光标编辑、↑↓历史(跨会话落盘)、Tab 补全(/命令 + @文件)、Shift+Tab 思考档、Ctrl+P 模型、
 * Alt+Enter 换行、Esc 中止、Ctrl+C 退出。运行中回车 = 插话(由 App 决定 steer / 排队)。
 */
export function InputBox({ busy, cwd, active = true, onSubmit, onAbort, onExit, onCycleThinking, onOpenModelPicker }: InputBoxProps): ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const vRef = useRef(value);
  const cRef = useRef(cursor);
  vRef.current = value;
  cRef.current = cursor;

  // 历史在模块级单例里(跨会话落盘,且不随本组件卸载丢失)。
  const history = inputHistory();
  const histIndex = useRef(-1);
  const draft = useRef('');

  // 同步更新 ref + state，保证同一 tick 连续按键读到最新值（避免 setState 异步导致的过期读）。
  const setVC = (nv: string, nc: number): void => {
    vRef.current = nv;
    cRef.current = nc;
    setValue(nv);
    setCursor(nc);
  };

  const insertAt = (s: string): void => {
    const v = vRef.current;
    const c = cRef.current;
    setVC(v.slice(0, c) + s + v.slice(c), c + s.length);
  };

  const applyCompletion = (): void => {
    const v = vRef.current;
    const c = cRef.current;
    const sugs = computeSuggestions(v, c, cwd);
    if (!sugs.length) return;
    const inserts = sugs.map((s) => s.insert);
    const { start, end } = wordAt(v, c);
    let replacement: string;
    if (inserts.length === 1) {
      replacement = inserts[0];
      if (!replacement.endsWith('/')) replacement += ' ';
    } else {
      const common = longestCommonPrefix(inserts);
      replacement = common.length > v.slice(start, c).length ? common : v.slice(start, c);
    }
    setVC(v.slice(0, start) + replacement + v.slice(end), start + replacement.length);
  };

  const historyPrev = (): void => {
    const h = history.list();
    if (!h.length) return;
    if (histIndex.current === -1) draft.current = vRef.current;
    histIndex.current = Math.min(histIndex.current + 1, h.length - 1);
    const val = h[h.length - 1 - histIndex.current];
    setVC(val, val.length);
  };
  const historyNext = (): void => {
    if (histIndex.current <= -1) return;
    histIndex.current -= 1;
    const h = history.list();
    const val = histIndex.current === -1 ? draft.current : h[h.length - 1 - histIndex.current];
    setVC(val, val.length);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy) onAbort();
      else onExit();
      return;
    }
    if (key.escape) {
      if (busy) onAbort();
      else setVC('', 0);
      return;
    }
    if (key.return) {
      if (key.meta) {
        insertAt('\n'); // Alt/Option+Enter 换行
        return;
      }
      const text = vRef.current;
      if (!text.trim()) return;
      history.add(text); // 以空格开头 / 与上条相同的不记;形似密钥的只留本会话不落盘
      histIndex.current = -1;
      draft.current = '';
      onSubmit(text);
      setVC('', 0);
      return;
    }
    // Shift+Tab 到达时是 name='tab' + shift:必须先于普通 Tab(补全)判。
    if (key.tab && key.shift) {
      onCycleThinking?.();
      return;
    }
    if (key.tab) {
      applyCompletion();
      return;
    }
    if (key.ctrl && input === 'p') {
      onOpenModelPicker?.();
      return;
    }
    if (key.upArrow) {
      historyPrev();
      return;
    }
    if (key.downArrow) {
      historyNext();
      return;
    }
    if (key.leftArrow) {
      setVC(vRef.current, Math.max(0, cRef.current - 1));
      return;
    }
    if (key.rightArrow) {
      setVC(vRef.current, Math.min(vRef.current.length, cRef.current + 1));
      return;
    }
    if (key.ctrl && input === 'a') {
      setVC(vRef.current, 0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setVC(vRef.current, vRef.current.length);
      return;
    }
    if (key.ctrl && input === 'u') {
      // 删到行首
      setVC(vRef.current.slice(cRef.current), 0);
      return;
    }
    if (key.backspace || key.delete) {
      const c = cRef.current;
      if (c <= 0) return;
      setVC(vRef.current.slice(0, c - 1) + vRef.current.slice(c), c - 1);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      insertAt(input);
      return;
    }
  }, { isActive: active });

  const suggestions = useMemo(() => computeSuggestions(value, cursor, cwd), [value, cursor, cwd]);

  const before = value.slice(0, cursor);
  const atChar = value.slice(cursor, cursor + 1) || ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={busy ? theme.dim : theme.accent} paddingX={1}>
        <Text>
          <Text color={theme.accent}>{'› '}</Text>
          <Text>{before}</Text>
          <Text inverse>{atChar}</Text>
          <Text>{after}</Text>
        </Text>
      </Box>
      {busy && !value ? (
        <Text color={theme.dim}>
          {L('  运行中：回车 = 插话（下一步注入）· Esc 中止', '  Running: Enter = steer (injected at the next step) · Esc to abort')}
        </Text>
      ) : null}
      {suggestions.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {suggestions.slice(0, 8).map((s) => (
            <Text key={s.label} color={theme.dim}>
              <Text color={theme.accent}>{s.label}</Text>
              {s.desc ? `  ${s.desc}` : ''}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
