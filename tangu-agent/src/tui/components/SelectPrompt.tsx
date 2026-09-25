/**
 * 通用选择器(/model、/think、/approval、/resume 与「开启完全放行？」确认都用它)。
 * ↑↓ / Ctrl+N Ctrl+P 移动 · PgUp PgDn 翻页 · Enter 选 · Esc / Ctrl+C 取消 · 直接打字过滤(Backspace 删、Ctrl+U 清空)。
 * 一屏最多 PICKER_PAGE_SIZE 行,光标越界才滚。纯逻辑在 ../picker.ts。
 */
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { L } from '../i18n.js';
import { dispWidth } from './Banner.js';
import { PICKER_PAGE_SIZE, filterItems, initialIndex, moveIndex, scrollStart, type PickerItem } from '../picker.js';

export interface SelectPromptProps<T> {
  title: string;
  /** 标题下一行灰字说明(可选)。 */
  subtitle?: string;
  items: PickerItem<T>[];
  initialQuery?: string;
  /** 初始光标落在这个值上(确认框默认停在「取消」用);缺省 = 当前项。 */
  initialValue?: T;
  /** 边框色(确认危险操作时用 warn)。 */
  tone?: 'accent' | 'warn';
  onSelect: (value: T) => void;
  onCancel: () => void;
}

export function SelectPrompt<T>({ title, subtitle, items, initialQuery = '', initialValue, tone = 'accent', onSelect, onCancel }: SelectPromptProps<T>): ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const filtered = useMemo(() => filterItems(items, query), [items, query]);
  const [cursor, setCursor] = useState(() => initialIndex(filterItems(items, initialQuery), initialValue));
  const [start, setStart] = useState(() => scrollStart(0, cursor, filterItems(items, initialQuery).length));
  // 按键处理读 ref 不读闭包(同 InputBox):Ink 的 useInput 在渲染后的 effect 里才换上新回调,
  // 两个按键挤在同一次渲染前到达(快速连打 / 按住 ↓ / CI 负载)时,第二个会读到旧的 query / 光标 —— 过滤丢字、光标少走一步。
  const live = useRef({ query, cursor, start });
  live.current = { query, cursor, start };

  const place = (list: PickerItem<T>[], idx: number, prevStart: number): void => {
    const st = scrollStart(prevStart, idx, list.length);
    live.current = { ...live.current, cursor: idx, start: st };
    setCursor(idx);
    setStart(st);
  };
  const retype = (q: string): void => {
    const list = filterItems(items, q);
    live.current = { ...live.current, query: q };
    setQuery(q);
    place(list, initialIndex(list, initialValue), 0);
  };

  useInput((input, key) => {
    const { query, cursor, start } = live.current;
    const filtered = filterItems(items, query);
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }
    if (key.return) {
      const it = filtered[cursor];
      if (it && !it.disabled) onSelect(it.value);
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) return place(filtered, moveIndex(filtered, cursor, -1), start);
    if (key.downArrow || (key.ctrl && input === 'n')) return place(filtered, moveIndex(filtered, cursor, 1), start);
    if (key.pageUp) return place(filtered, moveIndex(filtered, cursor, -PICKER_PAGE_SIZE), start);
    if (key.pageDown) return place(filtered, moveIndex(filtered, cursor, PICKER_PAGE_SIZE), start);
    if (key.ctrl && input === 'u') return retype('');
    if (key.backspace || key.delete) {
      if (query) retype(query.slice(0, -1));
      return;
    }
    if (key.tab) return;
    if (input && !key.ctrl && !key.meta) retype(query + input.replace(/[\r\n]+/g, ' '));
  });

  const visible = filtered.slice(start, start + PICKER_PAGE_SIZE);
  const labelW = Math.min(48, Math.max(0, ...visible.map((it) => dispWidth(it.label))));
  const pad = (s: string): string => s + ' '.repeat(Math.max(0, labelW - dispWidth(s)));
  const border = tone === 'warn' ? theme.warn : theme.accent;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
      <Text color={border} bold>
        {title}
      </Text>
      {subtitle ? <Text color={theme.dim}>{subtitle}</Text> : null}
      {items.length > 4 || query ? (
        <Text>
          <Text color={theme.dim}>{L('过滤 › ', 'Filter › ')}</Text>
          <Text>{query}</Text>
          <Text inverse> </Text>
          <Text color={theme.dim}>{`  ${filtered.length}/${items.length}`}</Text>
        </Text>
      ) : null}
      {start > 0 ? <Text color={theme.dim}>{`  ↑ ${L(`上面还有 ${start} 项`, `${start} more above`)}`}</Text> : null}
      {visible.length ? (
        visible.map((it, i) => {
          const at = start + i === cursor;
          const color = it.disabled ? theme.dim : at ? theme.accent : undefined;
          return (
            <Text key={`${start + i}:${it.label}`} wrap="truncate-end">
              <Text color={at ? theme.accent : theme.dim}>{at ? '› ' : '  '}</Text>
              <Text color={theme.success}>{it.current ? '✓ ' : '  '}</Text>
              <Text color={color} bold={at}>
                {pad(it.label)}
              </Text>
              {it.hint ? <Text color={theme.dim}>{`  ${it.hint}`}</Text> : null}
            </Text>
          );
        })
      ) : (
        <Text color={theme.dim}>{L('  （没有匹配项）', '  (no matches)')}</Text>
      )}
      {start + PICKER_PAGE_SIZE < filtered.length ? (
        <Text color={theme.dim}>{`  ↓ ${L(`下面还有 ${filtered.length - start - PICKER_PAGE_SIZE} 项`, `${filtered.length - start - PICKER_PAGE_SIZE} more below`)}`}</Text>
      ) : null}
      <Text color={theme.dim}>{L('↑↓ 移动 · Enter 选择 · Esc 取消 · 输入即过滤', '↑↓ move · Enter select · Esc cancel · type to filter')}</Text>
    </Box>
  );
}
