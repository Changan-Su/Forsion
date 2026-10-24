/**
 * 旁聊(/btw):带着会话上下文问一句题外话。渲染层这半 = 按会话存线程 + 流式请求引擎
 * `POST /agent/sessions/:id/aside`(tangu-agent services/aside.ts:不落库、无工具、不排主 run 的队)。
 *
 * 形态(2026-09-22 定,对标 Claude Code / Claude Desktop 的 /btw;10-18「挂点统一」改了打开位置与落库):
 *  - 桌面 / Web 主窗 = 对话右边那块子会话面板(ChildChatPanel,一次只开一个:开着子会话再点顺便问就换成顺便问)。
 *    卫星窗(独立窗 / Mini)里没有那块面板 → 仍开原生 Floating Panel(id `btw:<会话>`,会话级显隐见主进程 syncSessionPanels)。
 *  - 手机 = 全屏二级页(BtwHost page)。
 *  - 右侧栏视图 `btw-panel` 仍可手动放进侧栏,跟着主窗当前会话走。
 *  - 落库(10-18 用户「顺便问留下来」):每答完一问引擎写进 chat_asides,挂在某条消息上(anchors 记本会话当前这段挂在哪、记录 id);
 *    「从这里分出」里的那一行重开 = 把存下来的往返载回 threads。仍不进主对话的上下文、不进左栏、无工具。
 *  - 不写回主对话。要带回去由用户点「带回这里」:主窗输入框挂成引用,不动草稿(MainAction 'chat-quote')。
 *  - 附件(10-24 方案 A):输入区是共用 Chat Box,「+」/ 粘贴 / 拖入加图片和文件。附件只给这一问 —— 不进主对话、不进工作区;
 *    图片随请求走引擎的主对话同一条图片路,PDF / docx / 文本由引擎抽成文字。落库那一轮只留名字 + 小缩略图(引擎存);
 *    追问时之前的附件只当记录带上(名字 / 类型 / 大小),内容不再发。
 */
import { create } from 'zustand'
import { useWorkspace } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'
import { engineFetch, refForSession, targetForSession } from '../../services/engine/targets'
import { classify, classifyError, noteVerdict } from '../../services/engine/health'
import { AGENT_APP_ID, currentClientId, noteExtra, unitFailureMessage } from '../../services/agentRunService'
import { useApp } from '../../stores/appStore'
import { useChildChat } from '../../stores/childChatStore'
import { deleteAside, listAsides, type SavedAside } from '../../services/backendService'
import { mimeForExt, previewKindFor } from '../../services/fileKinds'
import { windowKind } from '../../windowKind'

registerMessages({
  'btw.title': { zh: '顺便问', en: 'By the way' },
  'btw.windowTitle': { zh: '顺便问 · {title}', en: 'By the way · {title}' },
  'btw.context': { zh: '当前对话', en: 'Conversation' },
  'btw.hint': { zh: '带着本会话上下文提问，不会加入对话，也不打断正在跑的任务', en: 'Uses this conversation as context. Not added to it, and never interrupts a running task.' },
  'btw.sideEmpty': { zh: '打开一个对话后，可以在这里顺便问', en: 'Open a conversation to ask side questions here' },
  'btw.empty': { zh: '问点与当前对话有关的事：概念、代码、刚才那步为什么这么做……', en: 'Ask about anything in this conversation: a concept, some code, why a step was taken…' },
  'btw.placeholder': { zh: '顺便问点什么…', en: 'Ask a side question…' },
  'btw.defaultQuestion': { zh: '解释一下这段', en: 'Explain this' },
  'btw.send': { zh: '发送', en: 'Send' },
  'btw.stop': { zh: '停止', en: 'Stop' },
  'btw.clear': { zh: '清空旁聊', en: 'Clear side chat' },
  'btw.copy': { zh: '复制', en: 'Copy' },
  'btw.copied': { zh: '已复制', en: 'Copied' },
  'btw.quoteToChat': { zh: '带回这里', en: 'Bring back' },
  'btw.quoted': { zh: '已带回输入框', en: 'Brought back to the chat box' },
  'btw.removeQuote': { zh: '移除引用', en: 'Remove quote' },
  'btw.thinking': { zh: '思考中…', en: 'Thinking…' },
  'btw.stopped': { zh: '已停止', en: 'Stopped' },
  'btw.noTools': { zh: '旁聊不能用工具，上面提到的操作都没有执行。', en: 'Side chats have no tools. Nothing mentioned above was run.' },
  'btw.errCut': { zh: '连接中断，回答不完整', en: 'The connection dropped before the answer finished' },
  'btw.errUnsupported': { zh: '当前引擎还不支持旁聊，请更新 Forsion', en: 'This engine does not support side questions yet. Update Forsion.' },
  'btw.close': { zh: '关闭', en: 'Close' },
  'btw.selectionAction': { zh: '顺便问', en: 'Ask aside' },
  'btw.cmd': { zh: '顺便问（旁聊）', en: 'Ask a side question' },
  'btw.attach': { zh: '添加图片或文件', en: 'Add images or files' },
  'btw.remove': { zh: '移除', en: 'Remove' },
  'btw.defaultAttachQuestion': { zh: '看看这个', en: 'Take a look at this' },
  'btw.att.noVision': { zh: '转成文字发送', en: 'sent as text' },
  'btw.att.skipped': { zh: '已跳过：{items}。顺便问可以附图片、PDF、Word（.docx）和文本文件，只给这一问用。', en: 'Skipped: {items}. Side questions take images, PDFs, Word (.docx) and text files, for this question only.' },
  'btw.att.unsupported': { zh: '{name}（不支持的类型）', en: '{name} (unsupported type)' },
  'btw.att.tooBig': { zh: '{name}（超 {mb}MB）', en: '{name} (over {mb}MB)' },
  'btw.att.tooMany': { zh: '{name}（一问最多 {n} 个）', en: '{name} (at most {n} per question)' },
  'btw.att.overTotal': { zh: '{name}（附件合计超 {mb}MB）', en: '{name} (attachments over {mb}MB in total)' },
  'btw.att.tooLarge': { zh: '附件太大：一问的附件合计不能超过 {mb}MB', en: 'Attachments are too large: at most {mb}MB in total per question' },
  'btw.att.ignored': { zh: '当前引擎没有收到附件，回答没有用到它们。请更新 Forsion', en: 'This engine did not receive the attachments, so the answer does not use them. Update Forsion.' },
  'btw.att.transcribed': { zh: '当前模型不能直接看图，图片先转成了文字', en: 'This model can’t view images, so they were described as text first' },
  'btw.describing': { zh: '正在把图片转成文字…', en: 'Describing the images as text…' },
  'btw.list.head': { zh: '这条回答上的顺便问 · {n}', en: 'Side questions on this answer · {n}' },
  'btw.list.new': { zh: '新的一段', en: 'New side question' },
  'btw.listSep': { zh: '、', en: ', ' },
})

/** 这一问要带的附件:与主输入框的 Attachment 同形({name, mimeType, data: base64, size}),图片另带一张小缩略图(落库用)。 */
export interface BtwAttachment { name: string; mimeType: string; data: string; size: number; thumb?: string }
/** 一轮里附过什么(显示 / 落库;不含内容)。 */
export interface BtwAttachmentMeta { name: string; mimeType: string; size?: number; thumb?: string }
/** 引擎 ASIDE_MAX_ATTACHMENTS / ASIDE_MAX_ATTACH_CHARS 同值:超了引擎回 400,这里先拦。 */
export const BTW_MAX_ATTACHMENTS = 8
export const BTW_MAX_ATTACH_CHARS = 18_000_000

export interface BtwTurn {
  id: string
  question: string
  quote?: string
  answer: string
  status: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  /** 模型把工具调用写成了文本(旁聊没有工具)→ 面板补一句「什么都没执行」。 */
  toolCallText?: boolean
  /** 这一问附了什么(只有记录和缩略图;内容发出去就不留了)。 */
  attachments?: BtwAttachmentMeta[]
  /** 附件的去向:ignored = 引擎没认(老引擎);transcribed = 当前模型看不了图,先转成了文字。 */
  attachNote?: 'ignored' | 'transcribed'
  /** 引擎正在把附图交给辅助视觉模型转写(还没开始答)。 */
  describing?: boolean
}

const metaOf = (a: BtwAttachmentMeta): BtwAttachmentMeta => ({ name: a.name, mimeType: a.mimeType, ...(a.size != null ? { size: a.size } : {}), ...(a.thumb ? { thumb: a.thumb } : {}) })

/** 存下来的顺便问里挂在某条回答上的那几段(与「从这里分出」ForkBlock 同一个来源、同一个筛法)。 */
export const asidesOnMessage = (saved: SavedAside[] | undefined, messageId: string | undefined): SavedAside[] =>
  messageId && saved ? saved.filter((a) => a.message_id === messageId) : []

/** 单张图上限 = 主输入框的 MAX_ATTACH_BYTES;文件另给 10MB(整份抽成文字放进这一问,太大也读不完)。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024
const READABLE = new Set(['pdf', 'docx', 'markdown', 'csv', 'json', 'code', 'text', 'html', 'diff'])

/** 顺便问收什么:图片(原生图像输入)/ 引擎读得出文字的文件(PDF、docx、文本类);其余 null。
 *  先按扩展名认(.ts 在有的系统上报 video/mp2t),认不出再看 MIME。 */
export function btwFileKind(name: string, mime: string): 'image' | 'doc' | null {
  const byName = previewKindFor('', name)
  const kind = byName === 'binary' ? previewKindFor(mime, name) : byName
  return kind === 'image' ? 'image' : READABLE.has(kind) ? 'doc' : null
}

const toBase64 = async (f: Blob): Promise<string> => {
  const bytes = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** 落库用的小缩略图:最长边 112px 的 JPEG(引擎只认 ≤12000 字符的 jpeg/png/webp data URL)。画不出来(格式 / 环境不支持)就不给,只留名字。 */
async function makeThumb(f: Blob): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(f)
    const scale = Math.min(1, 112 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale))
    c.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = c.getContext('2d')
    if (!ctx) return undefined
    ctx.fillStyle = '#fff' // 透明底的截图转 JPEG 不发黑
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close?.()
    for (const q of [0.72, 0.5, 0.3]) {
      const url = c.toDataURL('image/jpeg', q)
      if (url.startsWith('data:image/jpeg;base64,') && url.length <= 12_000) return url
    }
  } catch { /* 没有 createImageBitmap / 解不开的图:不给缩略图 */ }
  return undefined
}

/** 选中 / 粘贴 / 拖进来的文件 → 附件(与主输入框同形,base64)。超限、不支持的进 skipped(人话,面板上提示)。 */
export async function readBtwFiles(files: File[], have: BtwAttachment[]): Promise<{ added: BtwAttachment[]; skipped: string[] }> {
  const added: BtwAttachment[] = []
  const skipped: string[] = []
  let total = have.reduce((n, a) => n + a.data.length, 0)
  const mb = (n: number): string => String(Math.round(n / 1024 / 1024))
  for (const f of files) {
    const name = f.name || 'file'
    const kind = btwFileKind(name, f.type)
    if (!kind) { skipped.push(translate('btw.att.unsupported', { name })); continue }
    const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
    if (f.size > max) { skipped.push(translate('btw.att.tooBig', { name, mb: mb(max) })); continue }
    if (have.length + added.length >= BTW_MAX_ATTACHMENTS) { skipped.push(translate('btw.att.tooMany', { name, n: String(BTW_MAX_ATTACHMENTS) })); continue }
    const data = await toBase64(f)
    if (total + data.length > BTW_MAX_ATTACH_CHARS) { skipped.push(translate('btw.att.overTotal', { name, mb: mb(BTW_MAX_ATTACH_CHARS * 3 / 4) })); continue }
    total += data.length
    const mimeType = (kind === 'image' && !f.type.startsWith('image/') ? mimeForExt(name) : f.type) || mimeForExt(name) || (kind === 'image' ? 'image/png' : 'text/plain')
    const thumb = kind === 'image' ? await makeThumb(f) : undefined
    added.push({ name, mimeType, data, size: f.size, ...(thumb ? { thumb } : {}) })
  }
  return { added, skipped }
}

/** 读完再并进草稿:读盘是异步的,两批同时在读时各自只对着开读那一刻的草稿查过上限 —— 并进去前按**最新**的草稿再查一遍个数和总量
 *  (Codex 10-24 #3:7 + 两批各 1 曾并成 9 个,引擎只收 8 个且不吭声)。 */
export function mergeBtwAttachments(now: BtwAttachment[], added: BtwAttachment[]): { merged: BtwAttachment[]; skipped: string[] } {
  const merged = [...now]
  const skipped: string[] = []
  let total = now.reduce((n, a) => n + a.data.length, 0)
  for (const a of added) {
    if (merged.length >= BTW_MAX_ATTACHMENTS) { skipped.push(translate('btw.att.tooMany', { name: a.name, n: String(BTW_MAX_ATTACHMENTS) })); continue }
    if (total + a.data.length > BTW_MAX_ATTACH_CHARS) { skipped.push(translate('btw.att.overTotal', { name: a.name, mb: String(Math.round(BTW_MAX_ATTACH_CHARS * 3 / 4 / 1024 / 1024)) })); continue }
    total += a.data.length
    merged.push(a)
  }
  return { merged, skipped }
}

/** 打开旁聊时递给面板的一次性指令:带 question 就直接问,只带 quote 就挂成引用等用户打字。
 *  nonce 唯一,面板据此只消费一次 —— Web 上切走会话再切回会重挂面板,不能把同一个问题再问一遍。
 *  sessionId = 上下文会话;scope = 开的时候主窗当前会话(团队成员子聊天里两者不同),会话级显隐按 scope 判。 */
export interface BtwSeed {
  sessionId: string; scope?: string | null; title?: string; quote?: string; question?: string; modelId?: string; nonce: string
  /** 挂点:从哪条消息问的(消息操作条的「顺便问」带上;输入框 /btw 不带 → 引擎挂到最近一条回答)。和当前这段的挂点不同 → 另起一段。 */
  messageId?: string
  /** 重开存下来的那一段(「从这里分出」里点的)。 */
  asideId?: string
}

/** 与引擎 ASIDE_MAX_TURNS 同值:更早的往返不再带给模型。 */
const MAX_TURNS = 20
const controllers = new Map<string, AbortController>()
const savedLoads = new Set<string>()
const consumedSeeds = new Set<string>()
/** 上一问还在流时点了别的一段 / 别的挂点:记下,流完再切(Codex 10-18 #3)。每会话只留最后一次。 */
const pendingSeeds = new Map<string, BtwSeed>()
let seedSeq = 0

/** 这条指令第一次见 → true(并记下);同一 nonce 再来 → false。 */
export function consumeSeed(seed: BtwSeed): boolean {
  if (consumedSeeds.has(seed.nonce)) return false
  consumedSeeds.add(seed.nonce)
  return true
}

/** Web / 手机的旁聊此刻该不该露面:只在它归属的会话仍是当前会话时。BtwHost 渲染与安卓返回键共用这一条。 */
export function btwWebVisible(seed: BtwSeed | null, activeId: string | null): seed is BtwSeed {
  return !!seed && (!seed.scope || seed.scope === activeId)
}

/** 浮窗收到的 params(跨 IPC 的普通对象)→ 指令;缺会话或 nonce 就不是旁聊。 */
export function btwSeedOf(params: Record<string, unknown> | undefined): BtwSeed | null {
  const s = (k: string): string | undefined => (typeof params?.[k] === 'string' && (params[k] as string) ? params[k] as string : undefined)
  const sessionId = s('sessionId')
  const nonce = s('nonce')
  return sessionId && nonce ? { sessionId, nonce, scope: s('scope'), title: s('title'), quote: s('quote'), question: s('question'), modelId: s('modelId'), messageId: s('messageId'), asideId: s('asideId') } : null
}

interface BtwState {
  threads: Record<string, BtwTurn[]>
  /** Web / 手机当前开着的旁聊(桌面走原生浮窗,不用它)。只在它的会话仍是当前会话时显示。 */
  webOpen: BtwSeed | null
  /** 各会话旁聊输入区里还没发出去的东西(草稿 + 挂着的引用 + 附件 + 模型胶囊的选择)。放 store 不放组件:
   *  侧栏 / Web 的面板随会话切换重挂、主窗面板按 nonce 重挂,放组件里切走就丢。附件对象引用要稳(磁贴按对象认 key / 淡出)。 */
  compose: Record<string, BtwCompose>
  /** 各会话当前这段旁聊挂在哪条消息上、存成了哪条记录(第一问答完引擎回 asideId)。 */
  anchors: Record<string, { messageId?: string; asideId?: string }>
  /** 各会话存下来的顺便问(「从这里分出」按 message_id 取)。 */
  saved: Record<string, SavedAside[]>
  setCompose(sessionId: string, patch: Partial<BtwCompose>): void
  loadSaved(sessionId: string, force?: boolean): void
  /** 按指令切到对应的一段:asideId → 载回那条记录;换了挂点 → 另起一段;否则接着当前这段。 */
  applySeed(seed: BtwSeed, refetched?: boolean): void
  /** 「新的一段」:同一个挂点上另起一段(不删存下来的那段 —— 那是 clear 干的事)。上一问还在流就不动。 */
  startNew(sessionId: string): void
  ask(sessionId: string, question: string, quote?: string, modelId?: string, opts?: { attachments?: BtwAttachment[]; thinkingLevel?: string }): Promise<void>
  stop(sessionId: string): void
  clear(sessionId: string): void
  closeWeb(): void
}

export interface BtwCompose {
  draft: string
  quote?: string
  attachments?: BtwAttachment[]
  /** 模型胶囊:缺省跟当前会话的模型;改了只管本会话的顺便问。 */
  modelId?: string
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export const useBtw = create<BtwState>((set, get) => ({
  threads: {},
  webOpen: null,
  compose: {},
  anchors: {},
  saved: {},
  setCompose: (sessionId, patch) => set((s) => ({ compose: { ...s.compose, [sessionId]: { ...(s.compose[sessionId] ?? { draft: '' }), ...patch } } })),

  loadSaved: (sessionId, force) => {
    if (!force && (savedLoads.has(sessionId) || get().saved[sessionId])) return
    savedLoads.add(sessionId)
    void listAsides(targetForSession(sessionId), sessionId)
      .then((rows) => set((s) => ({ saved: { ...s.saved, [sessionId]: rows } })))
      .catch(() => {}) // 老引擎没有这条路由 / 离线:就是没有存下来的
      .finally(() => savedLoads.delete(sessionId))
  },

  applySeed: (seed, refetched?: boolean) => {
    const sid = seed.sessionId
    if (controllers.has(sid)) { pendingSeeds.set(sid, seed); return }
    const cur = get().anchors[sid] || {}
    if (seed.asideId) {
      if (cur.asideId === seed.asideId) return
      const rec = get().saved[sid]?.find((a) => a.id === seed.asideId)
      if (!rec) {
        // 新开的浮窗里 saved 还是空的:取一次再切(Codex 10-18 #4);取回来还没有 = 已删,照旧
        if (!refetched) {
          void listAsides(targetForSession(sid), sid)
            .then((rows) => { set((s) => ({ saved: { ...s.saved, [sid]: rows } })); get().applySeed(seed, true) })
            .catch(() => {})
        }
        return
      }
      const turns: BtwTurn[] = rec.turns.map((x, i) => ({
        id: `${rec.id}-${i}`, question: x.question, quote: x.quote, answer: x.answer, status: 'done',
        ...(Array.isArray(x.attachments) && x.attachments.length ? { attachments: x.attachments.map(metaOf) } : {}),
      }))
      set((s) => ({ threads: { ...s.threads, [sid]: turns }, anchors: { ...s.anchors, [sid]: { asideId: rec.id, messageId: rec.message_id || undefined } } }))
      return
    }
    if (seed.messageId && seed.messageId !== cur.messageId) {
      set((s) => ({ threads: { ...s.threads, [sid]: [] }, anchors: { ...s.anchors, [sid]: { messageId: seed.messageId } } }))
    }
  },

  startNew: (sessionId) => {
    if (controllers.has(sessionId)) return
    pendingSeeds.delete(sessionId)
    set((s) => ({ threads: { ...s.threads, [sessionId]: [] }, anchors: { ...s.anchors, [sessionId]: { messageId: s.anchors[sessionId]?.messageId } } }))
  },

  ask: async (sessionId, question, quote, modelId, opts) => {
    if (!question.trim() || controllers.has(sessionId)) return // 一次一问:上一问还在流
    const prior = get().threads[sessionId] || []
    const atts = opts?.attachments || []
    const id = `btw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const patch = (fn: (t: BtwTurn) => Partial<BtwTurn>): void => set((s) => ({
      threads: { ...s.threads, [sessionId]: (s.threads[sessionId] || []).map((t) => (t.id === id ? { ...t, ...fn(t) } : t)) },
    }))
    // 线程里只留附件记录(名字 / 缩略图),base64 内容只在这一次请求体里 —— 不然每段旁聊都把整张图攥在内存里
    set((s) => ({ threads: { ...s.threads, [sessionId]: [...prior, { id, question, quote, answer: '', status: 'streaming', ...(atts.length ? { attachments: atts.map(metaOf) } : {}) }] } }))
    const ac = new AbortController()
    controllers.set(sessionId, ac)
    // 追问:前几轮的附件只带记录(名字 / 类型 / 大小),内容和缩略图都不再发(10-18:旁聊轻量、不攒上下文)
    const thread = prior.filter((t) => t.status === 'done' && t.answer).slice(-MAX_TURNS)
      .map((t) => ({
        question: t.question, quote: t.quote, answer: t.answer,
        ...(t.attachments?.length ? { attachments: t.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, ...(a.size != null ? { size: a.size } : {}) })) } : {}),
      }))
    const anchor = get().anchors[sessionId] || {}
    // 图像识别档与辅助模型:同主对话发送(tanguSlice.sendNow)—— 会话在「我的电脑」上时那台有它自己的设置,不带本端的
    const cfg = useApp.getState().cfg
    const onUnit = refForSession(sessionId).kind === 'unit'
    const vision = atts.some((a) => a.mimeType.startsWith('image/')) && !onUnit
      ? { ...(cfg.visionModelId ? { vision_model_id: cfg.visionModelId } : {}), ...(cfg.visionMode ? { vision_mode: cfg.visionMode } : {}) }
      : {}
    const body = {
      question, quote, thread, model_id: modelId || undefined, message_id: anchor.messageId, aside_id: anchor.asideId,
      ...(atts.length ? { attachments: atts.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data, size: a.size, ...(a.thumb ? { thumb: a.thumb } : {}) })) } : {}),
      ...(opts?.thinkingLevel && opts.thinkingLevel !== 'off' ? { thinking_level: opts.thinkingLevel } : {}),
      ...vision,
    }
    try {
      await streamAside(sessionId, body, (ev) => {
        if (ev.type === 'delta') patch((t) => ({ answer: t.answer + String(ev.text ?? ''), describing: false }))
        else if (ev.type === 'status') { if (ev.phase === 'describing_images') patch(() => ({ describing: ev.stage === 'start' })) }
        else if (ev.type === 'done') {
          // 带了附件、done 却不报 attached = 引擎太老,没认附件:如实告诉用户,别让人以为模型看过了
          const attachNote = !atts.length ? undefined : !ev.attached ? 'ignored' as const : ev.attached.transcribed ? 'transcribed' as const : undefined
          patch((t) => ({ answer: String(ev.content || t.answer), status: 'done', toolCallText: !!ev.toolCallText, describing: false, ...(attachNote ? { attachNote } : {}) }))
          if (ev.asideId) {
            set((s) => ({ anchors: { ...s.anchors, [sessionId]: { messageId: ev.asideMessageId || s.anchors[sessionId]?.messageId, asideId: ev.asideId } } }))
            get().loadSaved(sessionId, true)
          }
        }
        else if (ev.type === 'error') patch(() => ({ status: 'error', describing: false, error: readableError(String(ev.error || '')) }))
      }, ac.signal)
      patch((t) => (t.status === 'streaming' ? { status: 'error', describing: false, error: translate('btw.errCut') } : {}))
    } catch (e: any) {
      patch((t) => (t.status !== 'streaming' ? {} : ac.signal.aborted ? { status: 'stopped', describing: false } : { status: 'error', describing: false, error: readableError(String(e?.message || e)) }))
    } finally {
      // 没答成(出错 / 停了):附件内容只在这次请求体里,线程里只有记录 —— 放回草稿,别让用户重新找一遍截图(Codex 10-24 #1)。
      // 用户已经在给下一问挂附件了就不覆盖;草稿空着顺手把问题也放回去,回车就能重发。
      const ended = get().threads[sessionId]?.find((t) => t.id === id)
      const cur = get().compose[sessionId]
      if (atts.length && ended && (ended.status === 'error' || ended.status === 'stopped') && !cur?.attachments?.length) {
        get().setCompose(sessionId, { attachments: atts, ...(cur?.draft?.trim() ? {} : { draft: question }) })
      }
      if (controllers.get(sessionId) === ac) controllers.delete(sessionId)
      const next = pendingSeeds.get(sessionId)
      if (next && !controllers.has(sessionId)) { pendingSeeds.delete(sessionId); get().applySeed(next) }
    }
  },

  stop: (sessionId) => controllers.get(sessionId)?.abort(),

  /** 清空 = 删掉存下来的这一段(「从这里分出」里那一行也没了),下一问另起一段。 */
  clear: (sessionId) => {
    controllers.get(sessionId)?.abort()
    controllers.delete(sessionId)
    const { asideId, messageId } = get().anchors[sessionId] || {}
    set((s) => ({ threads: { ...s.threads, [sessionId]: [] }, anchors: { ...s.anchors, [sessionId]: { messageId } } }))
    if (asideId) {
      set((s) => ({ saved: { ...s.saved, [sessionId]: (s.saved[sessionId] || []).filter((a) => a.id !== asideId) } }))
      void deleteAside(targetForSession(sessionId), sessionId, asideId).catch(() => {}) // 远端连着时引擎不许删:本端先不显示,重开会话后还在
    }
  },

  closeWeb: () => set({ webOpen: null }),
}))

/** 引擎的机器码 → 人话:额度用尽与主聊天同一句(chat.err.quota)。 */
const readableError = (raw: string): string => (/token_quota_exceeded/i.test(raw) ? translate('chat.err.quota') : raw)

type AsideEvent =
  | { type: 'delta'; text?: string }
  | { type: 'status'; phase?: string; stage?: 'start' | 'done' }
  | { type: 'done'; content?: string; toolCallText?: boolean; asideId?: string; asideMessageId?: string; attached?: { images: number; files: string[]; transcribed: boolean } }
  | { type: 'error'; error?: string }

async function streamAside(sessionId: string, body: Record<string, unknown>, onEvent: (ev: AsideEvent) => void, signal: AbortSignal): Promise<void> {
  // P1-K6:旁聊按会话所在的目标发(那台是「我的电脑」时走 hub 隧道);经解析层,不再自拼 URL / 鉴权头。
  // 一次性流,不做续订:unit 离线 / 引擎没起 / 设备被移除直接给人话(engine.target.*)。
  const t = targetForSession(sessionId)
  let r: Response
  try {
    r = await engineFetch(t, `/agent/sessions/${encodeURIComponent(sessionId)}/aside`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ ...body, app_id: AGENT_APP_ID, client: currentClientId() }),
    })
  } catch (e) {
    if (t.via === 'unit' && !signal.aborted) {
      const v = classifyError(e)
      throw new Error(unitFailureMessage(t, v, (e as { code?: unknown })?.code) || String((e as Error)?.message || e))
    }
    throw e
  }
  if (!r.ok || !r.body) {
    const raw = await r.text().catch(() => '')
    let detail = ''
    let code: string | undefined
    let j: unknown = null
    try { j = JSON.parse(raw); detail = String((j as { detail?: unknown })?.detail || ''); const c = (j as { code?: unknown })?.code; code = typeof c === 'string' ? c : undefined } catch { /* 非 JSON = 老引擎没有这条路由(Express 的 Cannot POST 页) */ }
    if (t.via === 'unit') {
      const v = classify(r.status, { code })
      noteVerdict(t.key, v, noteExtra(j))
      const msg = unitFailureMessage(t, v, code, j) // P1-KF:拒绝按 reason / state 分句
      if (msg && v !== 'fatal') throw new Error(msg)
    }
    // 附件合计过大:引擎 400 带 code;经网关时可能先被请求体上限挡成 413(没有 JSON)
    if (code === 'aside_attachments_too_large' || r.status === 413) throw new Error(translate('btw.att.tooLarge', { mb: String(Math.round(BTW_MAX_ATTACH_CHARS * 3 / 4 / 1024 / 1024)) }))
    throw new Error(detail || (r.status === 404 ? translate('btw.errUnsupported') : `HTTP ${r.status}`))
  }
  // 经网关代理时整段缓冲后一次到达也照样能解析,只是退化成非流式。
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5))) } catch { /* 坏行跳过 */ }
    }
  }
}

/**
 * 打开某会话的旁聊。主窗(桌面 / Web)开在对话右边的子会话面板;卫星窗开原生浮窗;手机挂到本页的 BtwHost(全屏二级页)。
 * 会话归属(浮窗的 sessionId,主进程据此显隐)取**主窗当前会话**而不是 opts.sessionId:在团队成员子聊天里问,
 * 上下文是子会话,但用户「在」的仍是父会话 —— 拿子会话当归属,浮窗一出生就会被判「不在当前会话」藏起来。
 * 卫星窗(独立窗 / Mini)里的 activeId 不可信,那里开的旁聊不绑会话,当普通浮窗。
 */
export function openBtw(opts: { sessionId: string; title?: string | null; quote?: string; question?: string; modelId?: string; messageId?: string; asideId?: string }): void {
  const scope = windowKind() === 'main' ? useApp.getState().activeId : null
  const seed: BtwSeed = { ...opts, title: opts.title || undefined, scope, nonce: `${Date.now().toString(36)}-${++seedSeq}` }
  if (scope && !window.tangu?.mobile) {
    useChildChat.getState().open(scope, { id: `aside:${opts.sessionId}`, title: translate('btw.title'), aside: seed })
    return
  }
  const tangu = window.tangu
  if (tangu?.openFloatingPanel) {
    void tangu.openFloatingPanel({
      id: `btw:${opts.sessionId}`,
      title: translate('btw.windowTitle', { title: opts.title || translate('btw.title') }),
      builtin: 'btw',
      params: { ...seed },
      ...(scope ? { sessionId: scope } : {}),
    })
    return
  }
  useBtw.setState({ webOpen: seed })
}

/** 把旁聊的回答带回主对话:挂成主窗聊天输入框的引用,不覆盖草稿。浮窗里调 = 请主窗代办(各窗一份 store)。
 *  主窗:侧栏聊天在前台就交给它,否则交给主区聊天(没开就开一个跟随当前会话的,同 draftInMainChat)。 */
export function quoteInMainChat(text: string): void {
  const body = text.trim().slice(0, 20000)
  if (!body) return
  if (windowKind() !== 'main' && window.tangu?.requestMainAction) { window.tangu.requestMainAction('chat-quote', body); return }
  const ws = useWorkspace.getState()
  const panelFront = ws.rightVisible && ws.rightTabs.some((tab) => tab.type === 'chat-panel' && tab.active)
  useApp.getState().setPendingChatQuote(panelFront ? 'chat-panel' : 'chat', body)
  if (!panelFront) ws.openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}
