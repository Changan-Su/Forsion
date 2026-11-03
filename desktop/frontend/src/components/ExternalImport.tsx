import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleCheck, Copy, Download, FolderInput, Loader2, Undo2, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { formatRelative } from '../format/time'
import type { EngineTarget } from '../services/engine/targets'
import type { DiscoveredMcp } from '../types'
import { HUMAN_CHANGED_EVENT } from '../services/humanCollaboration'
import { applyImport, getImportPlan, ignoreImport, scanImport, startImportPlan, undoImport, type ImportLedger, type ImportPlan, type ImportPlanView, type ImportScan, type ImportTool } from '../services/backendService'
import './externalImport.css'

/** 从其他 AI 导入(11-03,方案 B):「我 › 画像」顶上的提示行 / 完成条 + 一张审阅单;技能库和设置里也打开同一张单。
 *  引擎侧 services/externalImport(读本机文件、整理、写、撤销);MCP 仍走 Electron discovery(导入后停用)。
 *  云端 / 远端 / 旧引擎没有这组接口:整块不出现。 */

registerMessages({
  'aiImport.title': { zh: '从其他 AI 导入', en: 'Import from other AIs' },
  'aiImport.open': { zh: '从其他 AI 导入…', en: 'Import from other AIs…' },
  'aiImport.close': { zh: '关闭', en: 'Close' },
  'aiImport.sources.sum': { zh: '先选从哪搬。下一步会整理成一条一条，你看过、勾过才写进去。', en: "Pick where to bring things from. Next, they're sorted into single items, and nothing is saved until you've looked and ticked." },
  'aiImport.sources.local': { zh: '这台电脑上', en: 'On this computer' },
  'aiImport.sources.localCount': { zh: '找到 {n} 个', en: '{n} found' },
  'aiImport.sources.none': { zh: '没找到 Claude Code、Codex、Hermes、Gemini CLI、Cursor、Windsurf', en: 'No Claude Code, Codex, Hermes, Gemini CLI, Cursor or Windsurf found' },
  'aiImport.sources.web': { zh: '网页和手机上的 AI', en: 'AIs on the web and on your phone' },
  'aiImport.sources.webNote': { zh: 'ChatGPT · Claude · Gemini · 豆包 · Kimi · DeepSeek —— 它们的记忆存在网上，Forsion 读不到，请它自己写一份', en: "ChatGPT · Claude · Gemini · Doubao · Kimi · DeepSeek keep their memory online, where Forsion can't read it. Ask them to write it out" },
  'aiImport.sources.step1': { zh: '① 把提示词发给它', en: '1. Send it this prompt' },
  'aiImport.sources.copy': { zh: '复制提示词', en: 'Copy prompt' },
  'aiImport.sources.copied': { zh: '已复制', en: 'Copied' },
  'aiImport.sources.step2': { zh: '② 把它的回复贴到这里', en: '2. Paste its reply here' },
  'aiImport.sources.paste': { zh: '粘贴 ChatGPT、Claude 等的回复…', en: 'Paste the reply from ChatGPT, Claude or another AI…' },
  'aiImport.sources.foot': { zh: '读这些文件只在这台电脑上进行，确认前什么都不写。', en: 'Files are read only on this computer. Nothing is saved until you confirm.' },
  'aiImport.sources.next': { zh: '下一步：整理 {n} 个来源', en: 'Next: sort {n} sources' },
  'aiImport.count.about': { zh: '关于你 {n} 条', en: '{n} about you' },
  'aiImport.count.rules': { zh: '偏好 {n} 份', en: '{n} preference files' },
  'aiImport.count.project': { zh: '项目记忆 {n} 条', en: '{n} project notes' },
  'aiImport.count.notes': { zh: '它的笔记 {n} 条', en: '{n} of its notes' },
  'aiImport.count.skills': { zh: '技能 {n} 个', en: '{n} skills' },
  'aiImport.cancel': { zh: '取消', en: 'Cancel' },
  'aiImport.back': { zh: '上一步', en: 'Back' },
  'aiImport.working.sum': { zh: '正在整理。可以关掉这个窗口，整理好了再打开就能看到。', en: "Sorting. You can close this window; the result will be here when you reopen it." },
  'aiImport.working.step': { zh: '拆成一条一条，分到该去的地方，和已有的对一遍…', en: 'Splitting into single items, sending each where it belongs, checking against what you already have…' },
  'aiImport.working.progress': { zh: '{done} / {total} 批', en: 'Batch {done} of {total}' },
  'aiImport.working.skills': { zh: '技能和 MCP 不经过模型，按文件直接列出', en: "Skills and MCP servers don't go through the model; they're listed straight from the files" },
  'aiImport.working.foot': { zh: '整理只读不写。', en: 'Sorting only reads; it writes nothing.' },
  'aiImport.error.noModel': { zh: '没有可用的后台模型。先在设置 › 模型里配一个，再整理。', en: 'No background model is available. Set one up in Settings › Models, then sort again.' },
  'aiImport.error.gone': { zh: '这份单过期了，请重新整理。', en: 'This list is out of date. Please sort again.' },
  'aiImport.error.failed': { zh: '没成功：{e}', en: "Didn't work: {e}" },
  'aiImport.review.sum': { zh: '整理出 {total} 项，勾了 {n} 项。每项后面写着从哪来；点文字可以改，改完再导入。', en: 'Sorted into {total} items, {n} ticked. Each shows where it came from; click the text to edit it before importing.' },
  'aiImport.review.empty': { zh: '没整理出能导入的内容。', en: 'Nothing to import was found.' },
  'aiImport.review.foot': { zh: '确认前什么都没写。导入后可以整次撤销。', en: 'Nothing has been saved yet. You can undo the whole import afterwards.' },
  'aiImport.review.import': { zh: '导入 {n} 项', en: 'Import {n} items' },
  'aiImport.group.person': { zh: '关于你', en: 'About you' },
  'aiImport.group.personDest': { zh: '→ 我 › 画像', en: '→ Me › Portrait' },
  'aiImport.group.agent': { zh: '你希望 Agent 怎么做', en: 'How you want Agents to work' },
  'aiImport.group.agentDest': { zh: '→ 我 › 协作说明', en: '→ Me › Collaboration' },
  'aiImport.group.project': { zh: '项目 {name}', en: 'Project {name}' },
  'aiImport.group.projectDest': { zh: '→ 这个项目的记忆 · {path}', en: "→ This project's memory · {path}" },
  'aiImport.group.skills': { zh: '技能', en: 'Skills' },
  'aiImport.group.skillsDest': { zh: '→ 我的技能', en: '→ My skills' },
  'aiImport.group.mcp': { zh: 'MCP 服务器', en: 'MCP servers' },
  'aiImport.group.mcpDest': { zh: '→ 导入后是停用的，要用时在 MCP 页打开', en: '→ Imported turned off; turn them on in the MCP page when you need them' },
  'aiImport.group.out': { zh: '不导入的', en: 'Not imported' },
  'aiImport.flag.merged': { zh: '几处都提到，合成一条', en: 'Mentioned in several places, merged' },
  'aiImport.flag.sensitive': { zh: '健康、财务这类信息，默认不勾', en: 'Health, money or similar; not ticked by default' },
  'aiImport.flag.known': { zh: '已经有了', en: 'Already there' },
  'aiImport.flag.conflict': { zh: '和已有的一条不一致，勾上只加不替换', en: "Doesn't match one you have; ticking adds it without replacing" },
  'aiImport.flag.forgotten': { zh: '你之前删过这条', en: 'You removed this one before' },
  'aiImport.flag.blocked': { zh: '像是写给 AI 的命令，不能导入', en: "Looks like an instruction to an AI and can't be imported" },
  'aiImport.flag.past': { zh: '已经过去的事，要留就勾上', en: 'Already in the past; tick it to keep it' },
  'aiImport.flag.renamed': { zh: '和已有的技能同名，勾上会存成 {target}', en: 'Same name as a skill you have; ticking saves it as {target}' },
  'aiImport.flag.mentionsOther': { zh: '提到别家专有的工具或路径，可能要改', en: "Mentions another tool's own commands or paths; may need edits" },
  'aiImport.flag.tooBig': { zh: '文件太多，不能导入', en: "Too many files; can't be imported" },
  'aiImport.flag.scripts': { zh: '带 {n} 个脚本，导入时不运行', en: "Has {n} scripts; they don't run on import" },
  'aiImport.notice.persona': { zh: '这是 Hermes 的人设，以后可以用它新建一个 Agent', en: "This is Hermes's persona; later you'll be able to make an Agent from it" },
  'aiImport.notice.tooMany': { zh: '{tool} 在 {project} 里记了 {n} 条，太多了不逐条拆', en: '{tool} kept {n} notes for {project}; too many to split one by one' },
  'aiImport.notice.truncated': { zh: '贴的内容太长，只读了前面一部分，剩下的可以分开贴', en: 'The pasted text was too long, so only the first part was read. Paste the rest separately' },
  'aiImport.notice.missed': { zh: '有 {n} 段没整理成功，可以再整理一次', en: "{n} parts couldn't be sorted. You can sort again" },
  'aiImport.tool.pasted': { zh: '粘贴的回复', en: 'Pasted reply' },
  'aiImport.done.summary': { zh: '导入了 {n} 项：画像 {person} · 协作说明 {agent} · 项目记忆 {project} · 技能 {skill}', en: 'Imported {n} items: Portrait {person} · Collaboration {agent} · Project memory {project} · Skills {skill}' },
  'aiImport.done.mcp': { zh: '另有 MCP {n} 个，是停用的，在 MCP 页管理（撤销不含它们）', en: "Plus {n} MCP servers, turned off; manage them in the MCP page (undo doesn't include them)" },
  'aiImport.done.skipped': { zh: '{n} 项没写：已经有了，或者放不下了', en: "{n} items weren't saved: already there, or no room left" },
  'aiImport.done.from': { zh: '来自 {sources} · {time}', en: 'From {sources} · {time}' },
  'aiImport.done.undo': { zh: '撤销这次导入', en: 'Undo this import' },
  'aiImport.done.undone': { zh: '已撤销这次导入。', en: 'This import was undone.' },
  'aiImport.done.kept': { zh: '这几条之后改过，留着了：{list}', en: 'These were changed afterwards, so they were kept: {list}' },
  'aiImport.done.finish': { zh: '完成', en: 'Done' },
  'aiImport.hint.found': { zh: '在这台电脑上的 {apps} 里找到 {n} 项没导入过的记忆、偏好或技能', en: "Found {n} memories, preferences or skills in {apps} on this computer that you haven't imported" },
  'aiImport.hint.web': { zh: '也可以从 ChatGPT、Claude 这些网页上的 AI 搬过来', en: 'You can also bring them over from web AIs like ChatGPT and Claude' },
  'aiImport.hint.ignore': { zh: '忽略', en: 'Ignore' },
  'aiImport.hint.look': { zh: '看看…', en: 'Take a look…' },
  'aiImport.join': { zh: '、', en: ', ' },
  'aiImport.prompt': {
    zh: '请把你存着的关于我的记忆，以及从我们过去的对话里了解到的我，全部导出来。尽量保留我的原话，特别是我对你提过的要求和偏好。\n\n按这几类输出，顺序不变：\n## 关于我 —— 名字、所在地、工作、兴趣、长期在做的事\n## 我希望你怎么做 —— 我明确要你以后都这样做的事：语言、语气、格式、“总是…”“不要…”，以及我纠正过你的地方\n## 项目 —— 我在做的项目，每个一条：做什么、到了哪一步、定下来的决定；开头写项目名\n## 偏好 —— 口味、习惯、工作方式\n\n每条一行，格式：[YYYY-MM-DD] - 内容。不知道日期写 [unknown]。\n把整个导出放进一个代码块。最后说一句这是全部，还是还有更多。',
    en: 'Please export everything you have stored in memory about me, plus what you have learned about me from our past conversations. Keep my own words where you can, especially requests and preferences I have given you.\n\nUse these sections, in this order:\n## About me: name, location, work, interests, long-running things I do\n## How I want you to work: things I have explicitly asked you to always do, such as language, tone, format, "always..." and "never...", and places where I corrected you\n## Projects: projects I am working on, one line each with what it is, where it stands and decisions made; start with the project name\n## Preferences: tastes, habits, ways of working\n\nOne item per line, formatted as: [YYYY-MM-DD] - content. If you do not know the date, write [unknown].\nPut the whole export in one code block. At the end, say whether this is everything or there is more.',
  },
})

const TOOL_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', hermes: 'Hermes', cursor: 'Cursor', windsurf: 'Windsurf' }
const ECO_TOOL: Record<string, ImportTool> = { 'claude-code': 'claude-code', codex: 'codex', hermes: 'hermes' }
const FACT_MAX = 300 // 和引擎 cleanEdit 一样:超了引擎会退回原文,这里先挡住
const off = (e: any): boolean => e?.status === 404 || e?.code === 'IMPORT_LOCAL_ONLY' || e?.code === 'IMPORT_REMOTE_DENIED'

// 打开「我 › 画像」/ 技能页时扫一次,最多一分钟一次(只读文件,不经模型)
let scanCache: { key: string; at: number; data: ImportScan } | null = null
async function cachedScan(engine: EngineTarget, force = false): Promise<ImportScan> {
  const key = `${engine.key}|${engine.base}`
  if (!force && scanCache?.key === key && Date.now() - scanCache.at < 60_000) return scanCache.data
  const data = await scanImport(engine)
  scanCache = { key, at: Date.now(), data }
  return data
}
const DONE_EVENT = 'forsion:ai-import-done' // 导入 / 撤销后,画像页顶上那条重新扫

function useToolLabel() {
  const { t } = useI18n()
  return (id: ImportTool): string => (id === 'pasted' ? t('aiImport.tool.pasted') : TOOL_LABEL[id] || id)
}

/** 「我 › 画像」顶上:最近一次导入的完成条(24 小时内、没撤销),否则有新东西时一行提示,都没有就一颗小按钮。 */
export function ExternalImportEntry({ engine }: { engine: EngineTarget }) {
  const { t, locale } = useI18n()
  const label = useToolLabel()
  const [scan, setScan] = useState<ImportScan | null>(null)
  const [hidden, setHidden] = useState(false), [ignored, setIgnored] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [undone, setUndone] = useState<ImportLedger | null>(null)
  const [open, setOpen] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = useCallback(async (force = false) => {
    try { const s = await cachedScan(engine, force); if (alive.current) setScan(s) }
    catch (e) { if (alive.current) { if (off(e)) setHidden(true) } }
  }, [engine.key, engine.base])
  useEffect(() => { void load(); const again = () => void load(true); window.addEventListener(DONE_EVENT, again); return () => window.removeEventListener(DONE_EVENT, again) }, [load])
  if (hidden || !scan) return null
  const sheet = open && <ExternalImportSheet engine={engine} onClose={() => setOpen(false)} />
  const show = () => { setUndone(null); setOpen(true) }
  const last = scan.last
  const recent = last && !last.undoneAt && Date.now() - last.at < 24 * 3600_000
  const undo = async () => {
    if (!last || busy) return
    setBusy(true); setError('')
    try { const l = await undoImport(engine, last.id); if (alive.current) setUndone(l); window.dispatchEvent(new Event(HUMAN_CHANGED_EVENT)); window.dispatchEvent(new Event('forsion:skills-changed')); void load(true) }
    catch (e: any) { if (alive.current) setError(t('aiImport.error.failed', { e: e?.message || String(e) })) }
    finally { if (alive.current) setBusy(false) }
  }
  if (undone) return <>{sheet}<div className="imp-done" role="status" data-ai-import-undone><CircleCheck size={16} /><span className="grow">{t('aiImport.done.undone')}{!!undone.kept?.length && <small>{t('aiImport.done.kept', { list: undone.kept.join(t('aiImport.join')) })}</small>}</span></div></>
  if (recent && last) {
    const n = last.counts.person + last.counts.agent + last.counts.project + last.counts.skill
    return <>{sheet}<div className="imp-done" data-ai-import-done><CircleCheck size={16} />
      <span className="grow">{t('aiImport.done.summary', { n, ...last.counts })}
        <small>{t('aiImport.done.from', { sources: last.sources.map(label).join(t('aiImport.join')), time: formatRelative(last.at, { locale }) })}</small>
        {error && <small role="alert">{error}</small>}</span>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void undo()}>{busy ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />} {t('aiImport.done.undo')}</button>
    </div></>
  }
  if (scan.fresh > 0 && !ignored) return <>{sheet}<div className="imp-hint" data-ai-import-hint><FolderInput size={16} />
    <span className="grow">{t('aiImport.hint.found', { n: scan.fresh, apps: scan.freshTools.map(label).join(t('aiImport.join')) })}<small>{t('aiImport.hint.web')}</small></span>
    <button type="button" className="btn ghost sm" onClick={() => { setIgnored(true); void ignoreImport(engine).then(() => load(true)).catch(() => {}) }}>{t('aiImport.hint.ignore')}</button>
    <button type="button" className="btn ghost sm" onClick={show}><Download size={13} /> {t('aiImport.hint.look')}</button>
  </div></>
  return <>{sheet}<p className="portrait-move-entry"><button type="button" className="profile-text-action" data-ai-import-open onClick={show}>{t('aiImport.open')}</button></p></>
}

type Step = 'loading' | 'sources' | 'working' | 'review' | 'done'
/** 审阅单:选来源 → 整理(后台模型,只读)→ 勾 / 改 → 导入 → 可整次撤销。技能库和设置也直接打开它。 */
export function ExternalImportSheet({ engine, onClose }: { engine: EngineTarget; onClose: () => void }) {
  const { t, locale } = useI18n()
  const label = useToolLabel()
  const [step, setStep] = useState<Step>('loading')
  const [scan, setScan] = useState<ImportScan | null>(null)
  const [tools, setTools] = useState<Set<ImportTool>>(new Set())
  const [pasted, setPasted] = useState(''), [copied, setCopied] = useState(false)
  const [view, setView] = useState<ImportPlanView | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set()) // 条目 id / 技能 key / mcp:<生态>:<名>
  const [edits, setEdits] = useState<Record<string, string>>({}), [editing, setEditing] = useState('')
  const [mcp, setMcp] = useState<DiscoveredMcp[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<{ ledger: ImportLedger; skipped: number; mcp: number } | null>(null)
  const [undone, setUndone] = useState<ImportLedger | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const fail = (e: any) => { if (alive.current) setError(e?.code === 'IMPORT_PLAN_GONE' ? t('aiImport.error.gone') : t('aiImport.error.failed', { e: e?.message || String(e) })) }

  const toReview = (p: ImportPlan) => {
    setPlan(p); setEdits({}); setEditing('')
    setPicked(new Set([...p.items.filter((i) => i.checked).map((i) => i.id), ...p.skills.filter((s) => s.checked).map((s) => s.key)]))
    setStep('review')
    void window.tangu?.discoveryScan?.().then((r) => { if (alive.current) setMcp(r.mcpServers) }).catch(() => {})
  }
  // 打开时:整理在跑就接着看进度;刚整理好(半小时内)就直接到单上;否则选来源
  useEffect(() => {
    void (async () => {
      try {
        const [s, v] = await Promise.all([cachedScan(engine, true), getImportPlan(engine)])
        if (!alive.current) return
        setScan(s); setTools(new Set(s.tools.map((x) => x.id)))
        if (v.state === 'running') { setView(v); setStep('working') }
        else if (v.state === 'done' && v.plan && Date.now() - v.plan.createdAt < 30 * 60_000) toReview(v.plan)
        else setStep('sources')
      } catch (e) { fail(e); if (alive.current) setStep('sources') }
    })()
  }, [])
  useEffect(() => {
    if (step !== 'working') return
    const timer = window.setTimeout(() => {
      void getImportPlan(engine).then((v) => {
        if (!alive.current) return
        setView(v)
        if (v.state === 'done' && v.plan) toReview(v.plan)
        else if (v.state === 'error') { setError(v.error === 'IMPORT_NO_MODEL' ? t('aiImport.error.noModel') : t('aiImport.error.failed', { e: v.error || '' })); setStep('sources') }
      }).catch((e) => { fail(e); if (alive.current) setStep('sources') })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [step, view])

  const start = async () => {
    setBusy(true); setError('')
    try { const v = await startImportPlan(engine, { tools: [...tools], pasted: pasted.trim() || undefined, lang: locale === 'zh' ? 'zh' : 'en' }); if (alive.current) { setView(v); setStep('working') } }
    catch (e) { fail(e) } finally { if (alive.current) setBusy(false) }
  }
  const copyPrompt = () => { void navigator.clipboard?.writeText(t('aiImport.prompt')).then(() => { if (alive.current) { setCopied(true); window.setTimeout(() => alive.current && setCopied(false), 1500) } }) }
  const doImport = async () => {
    if (!plan || busy) return
    setBusy(true); setError('')
    try {
      const items = plan.items.filter((i) => picked.has(i.id) && !i.locked).map((i) => (edits[i.id] !== undefined && edits[i.id].trim() && edits[i.id] !== i.text ? { id: i.id, text: edits[i.id] } : { id: i.id }))
      const r = await applyImport(engine, { planId: plan.id, items, skills: plan.skills.filter((s) => picked.has(s.key)).map((s) => s.key) })
      const names = [...new Set(mcp.filter((m) => picked.has(`mcp:${m.ecosystem}:${m.name}`)).map((m) => m.name))]
      let mcpN = 0
      if (names.length && window.tangu?.discoveryImportMcp) { try { mcpN = (await window.tangu.discoveryImportMcp(names)).imported.length } catch { /* MCP 导不进不影响已写的 */ } }
      window.dispatchEvent(new Event(HUMAN_CHANGED_EVENT))
      if (r.ledger.counts.skill) { window.dispatchEvent(new Event('forsion:skills-changed')); window.tangu?.requestMainAction?.('skills-changed') }
      window.dispatchEvent(new Event(DONE_EVENT))
      if (alive.current) { setResult({ ...r, mcp: mcpN }); setStep('done') }
    } catch (e) { fail(e); if (alive.current && (e as any)?.code === 'IMPORT_PLAN_GONE') setStep('sources') }
    finally { if (alive.current) setBusy(false) }
  }
  const undo = async () => {
    if (!result || busy) return
    setBusy(true); setError('')
    try { const l = await undoImport(engine, result.ledger.id); if (alive.current) setUndone(l); window.dispatchEvent(new Event(HUMAN_CHANGED_EVENT)); window.dispatchEvent(new Event('forsion:skills-changed')); window.dispatchEvent(new Event(DONE_EVENT)) }
    catch (e) { fail(e) } finally { if (alive.current) setBusy(false) }
  }
  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const counts = (x: ImportScan['tools'][number]) => (['about', 'rules', 'project', 'notes', 'skills'] as const).filter((k) => x[k]).map((k) => t(`aiImport.count.${k}`, { n: x[k] })).join(' · ')

  const sec = (title: string, dest: string, count: string) => <div className="imp-sec"><span>{title}</span>{dest && <small>{dest}</small>}<span className="grow" />{count && <small>{count}</small>}</div>
  const tags = (sources: string[], flag?: string | null) => <span className="imp-tags">{sources.map((s) => <span key={s} className="imp-chip">{s}</span>)}{flag && <span className="imp-flag">{flag}</span>}</span>
  const row = (key: string, opts: { text: string; sub?: string; sources: string[]; flag?: string | null; locked?: boolean; editable?: boolean }) => (
    <div key={key} className={`imp-row${opts.locked ? ' is-off' : ''}`} data-ai-import-row={key}>
      <input type="checkbox" aria-label={opts.text} checked={!opts.locked && picked.has(key)} disabled={opts.locked || busy} onChange={() => toggle(key)} />
      <span className="imp-copy">
        {opts.editable && editing === key
          ? <textarea className="imp-edit" autoFocus rows={2} maxLength={FACT_MAX} value={edits[key] ?? opts.text} onChange={(e) => setEdits((m) => ({ ...m, [key]: e.target.value }))} onBlur={() => setEditing('')} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setEditing('') } }} />
          : opts.editable ? <button type="button" className="imp-text" onClick={() => setEditing(key)}>{edits[key] ?? opts.text}</button>
          : <span>{opts.text}</span>}
        {opts.sub && <small>{opts.sub}</small>}
        {tags(opts.sources, opts.flag)}
      </span>
    </div>)
  const itemFlag = (i: ImportPlan['items'][number]): string | null => {
    if (i.dest === 'blocked') return t('aiImport.flag.blocked')
    const f = i.flags.find((x) => x !== 'merged') ?? i.flags[0]
    if (f) return t(`aiImport.flag.${f}`)
    return i.dest === 'past' ? t('aiImport.flag.past') : null
  }
  const itemRow = (i: ImportPlan['items'][number]) => row(i.id, { text: i.text, sub: i.conflictWith, sources: i.sources.map(label), flag: itemFlag(i), locked: i.locked, editable: !i.locked })

  let body: ReactNode = null, foot: ReactNode = null, sum = ''
  if (step === 'loading') body = <p className="imp-sum" role="status"><Loader2 size={13} className="spin" /></p>
  if (step === 'sources' && scan) {
    const n = tools.size + (pasted.trim() ? 1 : 0)
    sum = t('aiImport.sources.sum')
    body = <>
      {sec(t('aiImport.sources.local'), scan.tools.length ? t('aiImport.sources.localCount', { n: scan.tools.length }) : '', '')}
      {scan.tools.length ? scan.tools.map((x) => <label key={x.id} className="imp-tool"><input type="checkbox" checked={tools.has(x.id)} onChange={() => setTools((s) => { const m = new Set(s); if (m.has(x.id)) m.delete(x.id); else m.add(x.id); return m })} />
        <span className="imp-copy"><span><b>{label(x.id)}</b></span><small>{counts(x)}</small></span></label>)
        : <div className="imp-ais">{t('aiImport.sources.none')}</div>}
      {sec(t('aiImport.sources.web'), '', '')}
      <div className="imp-ais">{t('aiImport.sources.webNote')}</div>
      <div className="imp-step"><span>{t('aiImport.sources.step1')}</span><span className="grow" /><button type="button" className="btn ghost sm" onClick={copyPrompt}><Copy size={13} /> {t(copied ? 'aiImport.sources.copied' : 'aiImport.sources.copy')}</button></div>
      <div className="imp-step"><span>{t('aiImport.sources.step2')}</span></div>
      <textarea className="imp-paste" value={pasted} placeholder={t('aiImport.sources.paste')} onChange={(e) => setPasted(e.target.value)} rows={5} />
    </>
    foot = <><span className="grow">{t('aiImport.sources.foot')}</span><button type="button" className="btn ghost sm" onClick={onClose}>{t('aiImport.cancel')}</button>
      <button type="button" className="btn primary sm" disabled={!n || busy} onClick={() => void start()}>{busy && <Loader2 size={13} className="spin" />}{t('aiImport.sources.next', { n })}</button></>
  }
  if (step === 'working') {
    sum = t('aiImport.working.sum')
    body = <>
      <div className="imp-prog"><Loader2 size={15} className="spin ok" /><span>{t('aiImport.working.step')}</span>{!!view?.total && <small>{t('aiImport.working.progress', { done: view.done, total: view.total })}</small>}</div>
      <div className="imp-prog is-quiet"><span>{t('aiImport.working.skills')}</span></div>
    </>
    foot = <><span className="grow">{t('aiImport.working.foot')}</span><button type="button" className="btn ghost sm" onClick={onClose}>{t('aiImport.close')}</button></>
  }
  if (step === 'review' && plan) {
    const by = (d: string) => plan.items.filter((i) => i.dest === d)
    const projects = [...new Set(by('project').map((i) => i.project!))]
    const out = [...by('blocked'), ...by('past')]
    const total = plan.items.length + plan.skills.length + mcp.length
    const n = plan.items.filter((i) => picked.has(i.id) && !i.locked).length + plan.skills.filter((s) => picked.has(s.key) && !s.locked).length + mcp.filter((m) => picked.has(`mcp:${m.ecosystem}:${m.name}`)).length
    const ratio = (list: Array<{ id: string; locked: boolean }>) => `${list.filter((i) => picked.has(i.id) && !i.locked).length} / ${list.length}`
    sum = total ? t('aiImport.review.sum', { total, n }) : t('aiImport.review.empty')
    const notes = [
      ...plan.notices.map((x, k) => row(`notice-${k}`, { text: x.kind === 'persona' ? x.path : x.kind === 'too-many' ? t('aiImport.notice.tooMany', { tool: label(x.tool), project: x.project || x.path, n: x.count ?? 0 }) : t('aiImport.notice.truncated'), sources: [label(x.tool)], flag: x.kind === 'persona' ? t('aiImport.notice.persona') : null, locked: true })),
      ...(plan.missed ? [row('missed', { text: t('aiImport.notice.missed', { n: plan.missed }), sources: [], locked: true })] : []),
    ]
    body = <>
      {!!by('person').length && <>{sec(t('aiImport.group.person'), t('aiImport.group.personDest'), ratio(by('person')))}{by('person').map(itemRow)}</>}
      {!!by('agent').length && <>{sec(t('aiImport.group.agent'), t('aiImport.group.agentDest'), ratio(by('agent')))}{by('agent').map(itemRow)}</>}
      {projects.map((p) => { const list = by('project').filter((i) => i.project === p); return <div key={p}>{sec(t('aiImport.group.project', { name: p.split(/[\\/]/).filter(Boolean).pop() || p }), t('aiImport.group.projectDest', { path: p }), ratio(list))}{list.map(itemRow)}</div> })}
      {!!plan.skills.length && <>{sec(t('aiImport.group.skills'), t('aiImport.group.skillsDest'), ratio(plan.skills.map((s) => ({ id: s.key, locked: s.locked }))))}
        {plan.skills.map((s) => row(s.key, { text: s.name, sub: s.description, sources: [label(s.tool)], locked: s.locked,
          flag: s.flags.includes('too-big') ? t('aiImport.flag.tooBig') : s.flags.includes('renamed') ? t('aiImport.flag.renamed', { target: s.target }) : s.flags.includes('mentions-other') ? t('aiImport.flag.mentionsOther') : s.scripts ? t('aiImport.flag.scripts', { n: s.scripts }) : null }))}</>}
      {!!mcp.length && <>{sec(t('aiImport.group.mcp'), t('aiImport.group.mcpDest'), `${mcp.filter((m) => picked.has(`mcp:${m.ecosystem}:${m.name}`)).length} / ${mcp.length}`)}
        {mcp.map((m) => row(`mcp:${m.ecosystem}:${m.name}`, { text: m.name, sub: m.config.command ? `${m.config.command} ${(m.config.args || []).join(' ')}` : m.config.url, sources: [label(ECO_TOOL[m.ecosystem] || m.ecosystem as ImportTool)] }))}</>}
      {!!(out.length + notes.length) && <>{sec(t('aiImport.group.out'), '', String(out.length + notes.length))}{out.map(itemRow)}{notes}</>}
    </>
    foot = <><span className="grow">{t('aiImport.review.foot')}</span><button type="button" className="btn ghost sm" disabled={busy} onClick={() => setStep('sources')}>{t('aiImport.back')}</button>
      <button type="button" className="btn primary sm" disabled={!n || busy} onClick={() => void doImport()}>{busy && <Loader2 size={13} className="spin" />}{t('aiImport.review.import', { n })}</button></>
  }
  if (step === 'done' && result) {
    const c = result.ledger.counts
    body = undone
      ? <div className="imp-done" role="status"><CircleCheck size={16} /><span className="grow">{t('aiImport.done.undone')}{!!undone.kept?.length && <small>{t('aiImport.done.kept', { list: undone.kept.join(t('aiImport.join')) })}</small>}</span></div>
      : <div className="imp-done" role="status" data-ai-import-result><CircleCheck size={16} /><span className="grow">{t('aiImport.done.summary', { n: c.person + c.agent + c.project + c.skill, ...c })}
        {!!result.skipped && <small>{t('aiImport.done.skipped', { n: result.skipped })}</small>}
        {!!result.mcp && <small>{t('aiImport.done.mcp', { n: result.mcp })}</small>}</span>
        {!!(c.person + c.agent + c.project + c.skill) && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void undo()}>{busy ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />} {t('aiImport.done.undo')}</button>}</div>
    foot = <><span className="grow" /><button type="button" className="btn primary sm" onClick={onClose}>{t('aiImport.done.finish')}</button></>
  }
  return createPortal(
    <div className="u-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="modal imp-sheet" role="dialog" aria-modal="true" aria-label={t('aiImport.title')} data-ai-import-step={step}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy && !editing) onClose() }}>
        <div className="modal-head"><span className="grow">{t('aiImport.title')}</span>
          <button type="button" className="icon-btn" aria-label={t('aiImport.close')} onClick={onClose} disabled={busy}><X size={15} /></button></div>
        {sum && <p className="imp-sum">{sum}</p>}
        {error && <p className="imp-sum imp-error" role="alert">{error}</p>}
        <div className="imp-body">{body}</div>
        {foot && <div className="imp-foot">{foot}</div>}
      </div>
    </div>, document.body)
}
