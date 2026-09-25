/**
 * 通用选择器(SelectPrompt)的纯逻辑:过滤 / 光标移动 / 滚动窗口。抽出来单测,组件只管按键与渲染。
 *
 * 过滤口径与 modelCatalog.resolveModelQuery 的子串阶段一致:小写 + 空格/下划线折成连字符,
 * 所以 `/model opus 5` 歧义时预填 "opus 5",列出来的恰好就是那批候选。
 */

export interface PickerItem<T> {
  label: string;
  /** 右侧灰字说明(不参与过滤,免得「high」把一屏模型都匹配上)。 */
  hint?: string;
  /** 额外参与过滤的文本(如模型显示名、档位 id)。 */
  keywords?: string;
  value: T;
  /** 当前生效项:渲染 ✓,并作为初始光标位置。 */
  current?: boolean;
  /** 不可选:光标跳过,Enter 无效。 */
  disabled?: boolean;
}

export const PICKER_PAGE_SIZE = 10;

const norm = (s: string): string => s.toLowerCase().replace(/[\s_]+/g, '-');

/** 大小写不敏感子串过滤(label + keywords);空查询原样返回。 */
export function filterItems<T>(items: PickerItem<T>[], query: string): PickerItem<T>[] {
  const q = norm(query.trim());
  if (!q) return items;
  return items.filter((it) => norm(it.label).includes(q) || (it.keywords ? norm(it.keywords).includes(q) : false));
}

/** 初始光标:指定值 → 当前项 → 第一个可选项;全不可选(或空)→ 0。 */
export function initialIndex<T>(items: PickerItem<T>[], preferValue?: T): number {
  if (preferValue !== undefined) {
    const i = items.findIndex((it) => it.value === preferValue && !it.disabled);
    if (i >= 0) return i;
  }
  const cur = items.findIndex((it) => it.current && !it.disabled);
  if (cur >= 0) return cur;
  const first = items.findIndex((it) => !it.disabled);
  return first >= 0 ? first : 0;
}

/**
 * 光标移动 |delta| 个「可选项」,跳过 disabled;到头即停(clamp,不回绕)。
 * 该方向上已无可选项 → 停在最后一个到得了的位置。
 */
export function moveIndex<T>(items: PickerItem<T>[], index: number, delta: number): number {
  if (!items.length || !delta) return Math.max(0, Math.min(index, items.length - 1));
  const step = delta > 0 ? 1 : -1;
  let at = Math.max(0, Math.min(index, items.length - 1));
  for (let n = Math.abs(delta); n > 0; n--) {
    let j = at + step;
    while (j >= 0 && j < items.length && items[j].disabled) j += step;
    if (j < 0 || j >= items.length) break;
    at = j;
  }
  return at;
}

/**
 * 滚动窗口起点:光标在窗口内就不动(翻页不抖),越界才把窗口推过去;总数不足一页恒为 0。
 */
export function scrollStart(prevStart: number, index: number, count: number, size = PICKER_PAGE_SIZE): number {
  if (count <= size) return 0;
  let s = prevStart;
  if (index < s) s = index;
  else if (index >= s + size) s = index - size + 1;
  return Math.max(0, Math.min(s, count - size));
}
