/**
 * 本机引擎当前登录的 Forsion 云端账号(中断任务续跑评审 #3 / 桌面 D1 D2)。
 *
 * 本机库的 user_id 恒是单用户的 `local`,分不出换没换过账号;自动续跑与排队认领要核对「这条 run 是哪个账号建的」,
 * 否则 A 的任务会在 B 的凭据下接着跑。账号取自云端令牌(JWT)里的 userId,只解码不验签 —— 这里只拿它比对「是不是同一个人」,
 * 鉴权仍由云端做。standalone 装配时登记令牌来源(assemble.ts);没登记(云端 worker / 测试)= 不核对。
 */
let tokenSource: (() => string) | null = null;

/** standalone 装配时调:每次现读当前令牌(配了 tokenFile 就是现读文件的那个函数)。null = 撤销。 */
export function setCloudTokenSource(fn: (() => string) | null): void { tokenSource = fn; }

/** 令牌 → 账号标识。'' = 没有令牌(未登录);null = 有令牌但看不出是谁(不是 JWT / 没有 userId)。 */
export function accountOfToken(token: string): string | null {
  const t = String(token || '').trim();
  if (!t) return '';
  const part = t.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const id = payload?.userId ?? payload?.sub;
    return typeof id === 'string' && id ? id : typeof id === 'number' ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * 当前账号:undefined = 本进程不核对账号(没登记令牌来源);'' = 未登录;null = 有令牌但认不出;其余 = 账号 id。
 * 读令牌抛错按「认不出」算 —— 读失败不等于没登录(magpie 那条:读失败 ≠ 空)。
 */
export function currentCloudAccount(): string | null | undefined {
  if (!tokenSource) return undefined;
  try { return accountOfToken(tokenSource()); } catch { return null; }
}

/**
 * 这条 run 记下的账号(input.cloudAccount)和现在的对不上吗。run 没记(老行 / 建的时候认不出)= 不拦;
 * 现在认不出(null)而 run 记过 = 按对不上算(宁可不续)。
 */
export function accountChanged(input: any): boolean {
  if (!input || typeof input.cloudAccount !== 'string') return false;
  const now = currentCloudAccount();
  if (now === undefined) return false;
  return now !== input.cloudAccount;
}
