/**
 * TUI 的极简双语:`L(zh, en)` 按系统语言挑一个。不做词典 / key 体系 —— TUI 文案就地成对写。
 *
 * 判定(进程内只算一次):TANGU_LANG(显式覆盖)→ LC_ALL → LC_MESSAGES → LANG → Intl 默认 locale;`zh*` → 中文,其余英文。
 * TUI 是独立终端进程,不做 IP 探测(同 Bluebird 口径:为一个默认值不值得起网络请求)。
 *
 * ⚠️ 旧文案(09-25 之前写的)大多仍是纯中文,是已知欠账;新增的用户可见文案一律走 L()。
 */

/** 纯函数判定,便于单测:env 优先,取不到再看 Intl。'C' / 'POSIX' 视为未设置。 */
export function detectZh(env: NodeJS.ProcessEnv = process.env, intlLocale?: string): boolean {
  for (const k of ['TANGU_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = (env[k] || '').trim();
    if (v && v !== 'C' && v !== 'POSIX' && !v.startsWith('C.')) return /^zh/i.test(v);
  }
  let loc = intlLocale;
  if (loc === undefined) {
    try {
      loc = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      loc = '';
    }
  }
  return /^zh/i.test(loc || '');
}

let zh: boolean | null = null;

export function uiIsZh(): boolean {
  if (zh === null) zh = detectZh();
  return zh;
}

/** 测试 / 调用方钉语言;传 null 回到自动判定。 */
export function setUiLocale(locale: 'zh' | 'en' | null): void {
  zh = locale === null ? null : locale === 'zh';
}

/** 双语文案:当前界面语言是中文取 zh,否则 en。 */
export const L = (zhText: string, enText: string): string => (uiIsZh() ? zhText : enText);
