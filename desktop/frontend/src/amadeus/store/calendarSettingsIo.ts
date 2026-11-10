/** 日历设置随账号走的那份文件的读写(human/Settings/calendar.db)。传输照缺省日历(humanCalendarIo):
 *  桌面问本机引擎,网页 / 手机问 server 的同名接口(homeTarget 的基址在网页 / 手机上已经带 /api)。
 *
 *  读有四种回答,调用方据此决定能不能写、能不能记「合过了」:
 *  · ok      —— 读到了:内容 + 不透明票据;
 *  · missing —— 对端**明确**说接口在、文件还没建(200 `{status:'missing', exists:false, version:null}`),可以建;
 *  · corrupt —— 422 HUMAN_SETTINGS_CORRUPT:坏了,不许覆盖;
 *  · unknown —— 其余一切:404(旧引擎 / 旧 server 根本没有这条接口)、401、5xx、超时、抛错、200 但不是上面两种形状。
 *    ⚠️和 humanCalendarIo 反着来的两处:那边 404 算「没有」、200 形状不对回落成空表;这里两者都是「不知道」——
 *    旧版本没有这条接口时绝不能被当成「确认没有」,否则新渲染层会拿本机那份去「新建」一份覆盖掉别人的。 */
import { dbFileSchema, type DbFile } from '@amadeus-shared/db/schema'
import { engineFetch, homeTarget } from '../../services/engine/targets'

export const SETTINGS_ENDPOINT = '/agent/human/Settings/calendar.db'
/** 挂住的请求会把单飞锁死:读写都带超时。 */
const TIMEOUT_MS = 15_000

export type SettingsRead =
  | { status: 'ok'; data: DbFile; version: string }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'unknown' }

export type SettingsWrite =
  | { status: 'ok'; version: string }
  /** 票据不对:带回对端此刻那份(ok / missing 才能重放再写;corrupt / unknown 停手)。 */
  | { status: 'conflict'; current: SettingsRead }
  /** 400 HUMAN_BAD_SETTINGS / 413 HUMAN_SETTINGS_TOO_LARGE:内容本身被拒,原样重试也没用。 */
  | { status: 'rejected'; error: string }
  /** 不知道写没写进去(网络错、超时、5xx、接口不存在……):改动留在队列里,下次重读再重放(改动都幂等)。 */
  | { status: 'unknown' }

export interface SettingsTransport {
  read(): Promise<SettingsRead>
  write(data: DbFile, version: string | null): Promise<SettingsWrite>
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
/** 只校验形状,返回原对象(zod 的 parse 会剥掉不认识的字段 —— 以后版本加的顶层字段要原样带回去)。 */
const validDb = (x: unknown): x is DbFile => isObj(x) && dbFileSchema.safeParse(x).success

/** 一份 GET 回包(或 409 带回的那份)→ 四态。只认两种确切的形状,别的都是「不知道」。 */
export function classifySettingsBody(body: unknown): SettingsRead {
  if (!isObj(body)) return { status: 'unknown' }
  if (body.status === 'ok' && body.exists === true && typeof body.version === 'string' && body.version && validDb(body.data))
    return { status: 'ok', data: body.data, version: body.version }
  if (body.status === 'missing' && body.exists === false && body.version === null) return { status: 'missing' }
  if (body.status === 'corrupt') return { status: 'corrupt' }
  return { status: 'unknown' }
}

async function jsonOf(r: Response): Promise<unknown> {
  try { return await r.json() } catch { return undefined }
}

export async function readCalendarSettings(): Promise<SettingsRead> {
  let r: Response
  try { r = await engineFetch(homeTarget(), SETTINGS_ENDPOINT, { method: 'GET' }, { timeoutMs: TIMEOUT_MS }) } catch { return { status: 'unknown' } }
  if (r.status === 422) {
    const body = await jsonOf(r)
    return isObj(body) && body.error === 'HUMAN_SETTINGS_CORRUPT' ? { status: 'corrupt' } : { status: 'unknown' }
  }
  if (r.status !== 200) return { status: 'unknown' }
  return classifySettingsBody(await jsonOf(r))
}

export async function writeCalendarSettings(data: DbFile, version: string | null): Promise<SettingsWrite> {
  let r: Response
  try {
    r = await engineFetch(homeTarget(), SETTINGS_ENDPOINT, { method: 'PUT', body: JSON.stringify({ data, version }) }, { timeoutMs: TIMEOUT_MS })
  } catch {
    return { status: 'unknown' }
  }
  const body = await jsonOf(r)
  if (r.status === 200) {
    return isObj(body) && body.ok === true && typeof body.version === 'string' && body.version ? { status: 'ok', version: body.version } : { status: 'unknown' }
  }
  if (r.status === 409) {
    if (!isObj(body) || body.error !== 'HUMAN_CONFLICT') return { status: 'unknown' }
    return { status: 'conflict', current: classifySettingsBody(body) }
  }
  const error = isObj(body) && typeof body.error === 'string' ? body.error : ''
  // 判超限看 error 字段,不只看 413(反代自己的 413 不是这条接口说的)
  if ((r.status === 400 && error === 'HUMAN_BAD_SETTINGS') || (r.status === 413 && error === 'HUMAN_SETTINGS_TOO_LARGE')) return { status: 'rejected', error }
  return { status: 'unknown' }
}

export const engineSettingsTransport: SettingsTransport = { read: readCalendarSettings, write: writeCalendarSettings }
