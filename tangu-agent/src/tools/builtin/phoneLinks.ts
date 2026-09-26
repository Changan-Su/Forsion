/**
 * 手机操控的链接模板与 scheme 分类(phone_navigate 的候选生成 / phone_open 的引擎侧预检)。
 * 契约 tangu-agent/docs/phone-control.md §4:原生 `view` op 收 ≤6 个候选,逐个 resolveActivity、第一个能开的生效;
 * 已装 App 清单**不离开手机**,所以引擎只给有序候选,不问装了什么。
 *
 * ⚠️ 最后核对:2026-09-25 —— 按各家公开 URI 文档写,**尚未在真机上逐条验证**(spike (g) 深链矩阵回填
 *    「拉起 / 落对页 / 被忽略」三态与日期)。国内地图 App 的 scheme 会随改版失效,改这里必须同步改日期,
 *    并在模拟器台架(mobile/scripts/phone-control-emu.cjs)里复测。标 UNVERIFIED 的参数是文档说法存疑的。
 */

export const NAV_MODES = ['drive', 'transit', 'walk', 'ride'] as const;
export const NAV_APPS = ['any', 'amap', 'baidu', 'tencent', 'google'] as const;
export type NavMode = (typeof NAV_MODES)[number];
export type NavApp = (typeof NAV_APPS)[number];

const enc = encodeURIComponent;

// 高德 amapuri://route/plan:t = 0 驾车 / 1 公交 / 2 步行 / 3 骑行;只给 dname(无坐标)时由高德自己检索终点。
const AMAP_T: Record<NavMode, number> = { drive: 0, transit: 1, walk: 2, ride: 3 };
// 百度 baidumap://map/direction:src 必填(andr.<公司>.<应用>);destination 可只给名称。
const BAIDU_MODE: Record<NavMode, string> = { drive: 'driving', transit: 'transit', walk: 'walking', ride: 'riding' };
// 腾讯 qqmap://map/routeplan:referer 文档写「开发者 key」—— 不带真 key 是否可用 UNVERIFIED。
const QQ_TYPE: Record<NavMode, string> = { drive: 'drive', transit: 'bus', walk: 'walk', ride: 'bike' };
// google.navigation 不支持公交 → 公交走 https maps/dir(装了 Google 地图会被它接走,否则落浏览器)。
const GOOGLE_NAV: Partial<Record<NavMode, string>> = { drive: 'd', walk: 'w', ride: 'b' };
const GOOGLE_TRAVEL: Record<NavMode, string> = { drive: 'driving', transit: 'transit', walk: 'walking', ride: 'bicycling' };

const amap = (d: string, m: NavMode): string => `amapuri://route/plan/?sourceApplication=Forsion&dname=${enc(d)}&dev=0&t=${AMAP_T[m]}`;
const amapWeb = (d: string): string => `https://uri.amap.com/search?keyword=${enc(d)}&src=forsion&callnative=1`;
const baidu = (d: string, m: NavMode): string => `baidumap://map/direction?destination=${enc(d)}&mode=${BAIDU_MODE[m]}&src=andr.forsion.tangu`;
const tencent = (d: string, m: NavMode): string => `qqmap://map/routeplan?type=${QQ_TYPE[m]}&to=${enc(d)}&referer=Forsion`;
const googleWeb = (d: string, m: NavMode): string => `https://www.google.com/maps/dir/?api=1&destination=${enc(d)}&travelmode=${GOOGLE_TRAVEL[m]}`;
const google = (d: string, m: NavMode): string => (GOOGLE_NAV[m] ? `google.navigation:q=${enc(d)}&mode=${GOOGLE_NAV[m]}` : googleWeb(d, m));
const geo = (d: string): string => `geo:0,0?q=${enc(d)}`;

/**
 * 有序候选:App scheme 在前(能直接出路线),https / geo 兜底(geo 交给系统默认地图,只落点不出路线)。
 * `any` 按国内装机量排:高德 → 百度 → 腾讯 → Google → geo(海外机上前三个解析不到,自然落到 Google)。
 * ⚠️ `any` 里**不放** Google 的 https 链接:没装 Google 地图的国内机会落到浏览器打开 google.com。
 */
export function navigationCandidates(destination: string, mode: NavMode = 'drive', app: NavApp = 'any'): string[] {
  const d = destination;
  switch (app) {
    case 'amap': return [amap(d, mode), amapWeb(d), geo(d)];
    case 'baidu': return [baidu(d, mode), geo(d)];
    case 'tencent': return [tencent(d, mode), geo(d)];
    case 'google': return [...new Set([google(d, mode), googleWeb(d, mode)]), geo(d)];
    default: return [amap(d, mode), baidu(d, mode), tencent(d, mode), ...(GOOGLE_NAV[mode] ? [google(d, mode)] : []), geo(d)];
  }
}

/**
 * 引擎侧直接拒的 scheme(原生侧同样拒,这里是纵深防御 + 省一次往返):能指向任意组件 / 本地文件 / 执行脚本的,
 * 外加 Forsion 手机端自己的 `tangu`:`tangu://auth-callback?token=…` 会被当成登录回跳吃下(换号,登录 CSRF)。
 */
const REFUSED_SCHEMES = new Set(['intent', 'android-app', 'file', 'content', 'javascript', 'data', 'tangu']);
/** 草稿类 scheme:交给 phone_compose(那边只开草稿、结果恒写 NOT sent,拨号只用 ACTION_DIAL)。 */
const COMPOSE_SCHEMES = new Set(['tel', 'sms', 'smsto', 'mms', 'mmsto', 'mailto']);
const SCHEME_RE = /^([a-z][a-z0-9+.-]{0,31}):/i;
const MAX_URL = 2048;

export type PhoneUrlClass =
  | { kind: 'ok'; scheme: string }
  | { kind: 'compose'; scheme: string }
  | { kind: 'refused'; scheme: string }
  | { kind: 'invalid'; reason: string };

/** phone_open(url) 的预检。只认「scheme:其余」形态、无空白 / 控制字符、≤2048。 */
export function classifyPhoneUrl(raw: string): PhoneUrlClass {
  const url = raw.trim();
  if (!url) return { kind: 'invalid', reason: 'url is empty' };
  if (url.length > MAX_URL) return { kind: 'invalid', reason: `url is longer than ${MAX_URL} characters` };
  if (/[\s\u0000-\u001F\u007F]/.test(url)) return { kind: 'invalid', reason: 'url must not contain spaces or control characters (percent-encode them)' };
  const m = SCHEME_RE.exec(url);
  if (!m) return { kind: 'invalid', reason: 'url must start with a scheme such as https:// or an app scheme like bilibili://' };
  const scheme = m[1].toLowerCase();
  if (REFUSED_SCHEMES.has(scheme)) return { kind: 'refused', scheme };
  if (COMPOSE_SCHEMES.has(scheme)) return { kind: 'compose', scheme };
  return { kind: 'ok', scheme };
}
