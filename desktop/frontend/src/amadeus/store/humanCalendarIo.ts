/** 默认日历 = 引擎家目录里的 human/CALENDAR.db(10-21 用户:「新的默认 Calendar 文件应该是 human 文件夹里面用户的 calendar」)。
 *  它不在笔记库里:dbStore 遇到 HUMAN_CAL 这个 ref 就改走这里的两条引擎接口,防抖、比对交换写、冲突重放、撤销都照原样复用。
 *  桌面走本机引擎，网页和手机走云端的同名接口；两端使用相同的 human/ 文件。 */
import type { DbFile } from '@amadeus-shared/db/schema'
import { engineFetch, homeTarget } from '../../services/engine/targets'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'humancal.name': { zh: '我的日历', en: 'My calendar' },
  'humancal.colName': { zh: '名称', en: 'Name' },
  'humancal.colDate': { zh: '日期', en: 'Date' },
  'humancal.colDone': { zh: '完成', en: 'Done' },
})

export const HUMAN_CAL = 'human://CALENDAR.db'
const ENDPOINT = '/agent/human/CALENDAR.db'

/** 旧位置镜像的那份(默认笔记库根上的 Calendar.db,绝对路径):日历视图据此不把它当成另一本日历重复显示。 */
let legacyAbs: string | null = null
export const humanCalLegacy = (): string | null => legacyAbs

/** version '' = 引擎那边还没有这份文件:第一次写按「新建」发(version: null)。 */
export type HumanCalRead =
  | { status: 'ok'; path: string; data: DbFile; version: string }
  | { status: 'corrupt'; path: string; message: string }
  | { status: 'missing' }

// 列 id 固定:两个窗口同时首次建的话,后写的那个 409 后重读前一个的表,重放的改动引用的列照样对得上(随机 id 会写到不存在的列上,Codex 评审)
const emptyCalendar = (): DbFile => ({
  version: 2,
  name: translate('humancal.name'),
  columns: [
    { id: 'name', name: translate('humancal.colName'), type: 'text' },
    { id: 'date', name: translate('humancal.colDate'), type: 'calendarDate' },
    { id: 'done', name: translate('humancal.colDone'), type: 'checkbox' },
  ],
  rows: [],
})

export async function readHumanCal(): Promise<HumanCalRead> {
  let r: Response
  try { r = await engineFetch(homeTarget(), ENDPOINT, { method: 'GET' }) } catch { return { status: 'missing' } }
  if (r.status === 422) return { status: 'corrupt', path: HUMAN_CAL, message: 'human/CALENDAR.db is not valid JSON' }
  if (!r.ok) return { status: 'missing' } // 旧引擎没有这条接口 / 引擎不在本机
  const body = await r.json()
  legacyAbs = typeof body.legacy === 'string' ? body.legacy : null
  if (body.status === 'ok') return { status: 'ok', path: HUMAN_CAL, data: body.data as DbFile, version: String(body.version) }
  return { status: 'ok', path: HUMAN_CAL, data: emptyCalendar(), version: '' }
}

/** 比对交换写:ok:false = 引擎那份在我们读过之后变了(同步拉下来 / 镜像合进来 / 别的窗口写了),由 dbStore 重读再重放。 */
export async function writeHumanCalCas(data: DbFile, version: string): Promise<{ ok: true; version: string } | { ok: false }> {
  const r = await engineFetch(homeTarget(), ENDPOINT, { method: 'PUT', body: JSON.stringify({ data, version: version || null }) })
  if (r.status === 409) return { ok: false }
  if (!r.ok) throw new Error(`human calendar write failed: HTTP ${r.status}`) // dbStore 留着改动、重新武装定时器
  const body = await r.json()
  return { ok: true, version: String(body.version) }
}
