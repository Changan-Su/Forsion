/**
 * `cloud:fetch` 的路径解析闸(独立成文件是为了能被 vitest 直接 import ——
 * main.ts 一进测试就会把 electron-updater 等整条主进程模块图拖进来,跑不起来;
 * 同 unitP2p.ts 的分法:纯逻辑零 electron 依赖)。
 */
/**
 * 把插件给的**相对路径**解析成 Forsion 云端 API 的绝对地址;非法一律返回 null。
 *
 * 这是 `cloud:fetch` 的安全边界:主进程会给这个地址盖上用户的 forsion_token。
 * 真正起作用的是**两条**,别搞混哪条在防什么(实测,见 cloudFetchPath.test.ts):
 *
 *  ① `path` 必须以 `/` 开头 —— 这条挡住绝对 URL(`https://evil.com/x` 直接被拒)。
 *  ② 解析后 pathname 必须仍在 `/api/` 之下 —— 这条挡住 `/../units` 那族穿越,
 *    它们**不改 origin**、只是抬出前缀,正则很难拿捏,交给 URL 归一化后比对最稳。
 *
 * ⚠️ 而 origin 比对那条**在当前拼法下永不触发**:因为总是 `origin + '/api' + path` 锚定,
 * `//evil.com/x` 只会解析成自家服务器上的一个怪路径(`/api//evil.com/x`),不是外泄。
 * 保留它是纵深防御(将来有人改了拼接方式时兜底),但别把它当成「挡协议相对 URL 的那道闸」——
 * 那是个恒真的假保护,写进注释会误导下一个人放松 ①②。
 */
export function resolveCloudApiUrl(cloudUrl: unknown, path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  // 桌面端 cloudUrl 是纯源;web/mobile 垫片那种已含 /api 的形态剥一次,免得拼成 /api/api。
  const origin = String(cloudUrl || '').replace(/\/+$/, '').replace(/\/api$/, '')
  if (!origin) return null
  let base: URL
  let target: URL
  try {
    base = new URL(origin)
    target = new URL(origin + '/api' + path)
  } catch { return null }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null
  if (target.origin !== base.origin) return null // 挡 `//evil.com/x` 与绝对 URL
  if (!target.pathname.startsWith('/api/')) return null // 挡 `/../x` 逃出前缀
  return target.toString()
}
