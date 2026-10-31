import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { registerMessages, useI18n } from '../i18n'
import { McpInputError, checkMcpNames, parseMcpInput, publicMcpUrl, type McpServerMap } from '../../../shared/mcpConfig'
import { ipcErrorText } from '../ipcError'
import './McpImportDialog.css'

registerMessages({
  'mcpImport.open': { zh: '粘贴 JSON', en: 'Paste JSON' },
  'mcpImport.config': { zh: 'MCP 配置', en: 'MCP configuration' },
  'mcpImport.formats': { zh: '支持 mcpServers 对象、带名称的服务器对象，以及单个服务器配置。', en: 'Accepts mcpServers, named server objects, or a single server configuration.' },
  'mcpImport.name': { zh: '服务器名称', en: 'Server name' },
  'mcpImport.check': { zh: '检查配置', en: 'Check configuration' },
  'mcpImport.save': { zh: '添加并连接', en: 'Add and connect' },
  'mcpImport.back': { zh: '返回编辑', en: 'Back to editing' },
  'mcpImport.detected': { zh: '已识别 {count} 个服务器', en: '{count} servers detected' },
  'mcpImport.new': { zh: '新增', en: 'New' },
  'mcpImport.skip': { zh: '跳过', en: 'Skip' },
  'mcpImport.replace': { zh: '覆盖现有配置', en: 'Replace existing configuration' },
  'mcpImport.summary': { zh: '{added} 个新增 · {replaced} 个覆盖 · {skipped} 个跳过', en: '{added} new · {replaced} replacements · {skipped} skipped' },
  'mcpImport.credentials': { zh: '凭据已包含在配置中，预览隐藏其值。活动运行结束后连接，后续运行可使用新工具。', en: 'Credentials are included and hidden in this preview. Connections update after active runs finish; subsequent runs can use the new tools.' },
  'mcpImport.saved': { zh: '配置已保存。新增 {added} 个，更新 {replaced} 个；实际连接状态将在列表中更新。', en: 'Configuration saved. {added} added, {replaced} updated. Actual connection status will update in the list.' },
  'mcpImport.agentHint': { zh: 'Agent 也可以帮你配置 MCP，写入遵循当前审批权限。', en: 'Agents can also configure MCP, following your current approval settings.' },
  'mcpImport.error.json': { zh: 'JSON 语法有误，请修正后重试。', en: 'Invalid JSON syntax. Fix it and retry.' },
  'mcpImport.error.object': { zh: '配置必须是 JSON 对象。', en: 'The configuration must be a JSON object.' },
  'mcpImport.error.empty': { zh: '配置中没有服务器。', en: 'The configuration contains no servers.' },
  'mcpImport.error.nameRequired': { zh: '单个服务器配置需要补充名称。', en: 'Enter a name for this single server configuration.' },
  'mcpImport.error.name': { zh: '服务器名称为空、过长或包含无效字符。', en: 'The server name is empty, too long, or contains invalid characters.' },
  'mcpImport.error.field': { zh: '存在不支持的字段，请检查配置。', en: 'The configuration contains an unsupported field.' },
  'mcpImport.error.invalid': { zh: '字段值有误；命令和 URL 需二选一，参数必须为字符串数组。', en: 'Invalid field value. Use either command or URL; args must be a string array.' },
  'mcpImport.error.reserved': { zh: '该名称由设备 MCP 保留，请换一个名称。', en: 'This name is reserved for device MCP. Choose another name.' },
  'mcpImport.error.collision': { zh: '该名称会与已有服务器的工具名称冲突，请换一个名称。', en: 'This name would collide with an existing server’s tool names. Choose another name.' },
  'mcpImport.error.conflict': { zh: '配置已被其他操作修改，请返回编辑并重新检查。', en: 'Another operation changed this configuration. Go back and check it again.' },
  'mcpImport.error.line': { zh: '第 {line} 行', en: 'Line {line}' },
  'mcpImport.error.plugin': { zh: '该名称属于插件自带的服务器，请换一个名称。', en: 'This name belongs to a plugin server. Choose another name.' },
})

export interface McpImportDraft { json: string; name: string }
type ImportResult = { mcpServers: McpServerMap; added: string[]; replaced: string[]; skipped: string[] }
const placeholder = '{\n  "mcpServers": {\n    "notes": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}'
export function McpImportDialog({ draft, onDraft, pluginNames, onClose, onSaved }: {
  draft: McpImportDraft; onDraft: (value: McpImportDraft) => void; pluginNames: string[]; onClose: () => void; onSaved: (value: ImportResult) => void
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [preview, setPreview] = useState<{ incoming: McpServerMap; expected: McpServerMap } | null>(null)
  const [replace, setReplace] = useState<string[]>([])
  const [needsName, setNeedsName] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!busyRef.current) closeRef.current(); return }
      if (e.key !== 'Tab') return
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])]
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (preview) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); else input.current?.focus() }, [preview])
  const showError = (e: unknown) => {
    const known = e instanceof McpInputError ? e : null
    // Electron wraps thrown errors; retain a localized conflict message without echoing the supplied JSON.
    const remote = !known ? /MCP configuration: (json|object|empty|nameRequired|name|field|invalid|reserved|collision|conflict)(?: \(([^)]*)\))?/.exec(String(e)) : null
    const ipcKnown = remote ? new McpInputError(remote[1] as McpInputError['code'], remote[2] || '') : null
    setError(known ? `${t(`mcpImport.error.${known.code}`)}${known.path ? ` · ${known.path}` : ''}${known.line ? ` · ${t('mcpImport.error.line', { line: known.line })}` : ''}` : ipcKnown ? `${t(`mcpImport.error.${ipcKnown.code}`)}${ipcKnown.path ? ` · ${ipcKnown.path}` : ''}` : ipcErrorText(e))
    if (known?.code === 'nameRequired') setNeedsName(true)
  }
  const check = async () => {
    setError(''); setBusy(true)
    try {
      const incoming = parseMcpInput(draft.json, draft.name)
      if (Object.keys(incoming).some(n => pluginNames.includes(n))) { setError(t('mcpImport.error.plugin')); return }
      const current = await window.tangu!.readMcpConfig!()
      checkMcpNames(incoming, current.mcpServers)
      setReplace([]); setPreview({ incoming, expected: current.mcpServers })
    } catch (e) { showError(e) } finally { setBusy(false) }
  }
  const save = async () => {
    if (!preview) return
    setBusy(true); setError('')
    try {
      const result = await window.tangu!.importMcpConfig!({ config: { mcpServers: preview.incoming }, replaceNames: replace, expected: preview.expected })
      onSaved(result)
    } catch (e) { showError(e); setBusy(false) }
  }
  const added = preview ? Object.keys(preview.incoming).filter(n => !Object.hasOwn(preview.expected, n)).length : 0
  return createPortal(<div className="modal-overlay mcp-import-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
    <div className="modal mcp-import-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="mcp-import-title" aria-busy={busy}>
      <div className="mcp-import-heading"><h3 id="mcp-import-title">{t('mcpImport.open')}</h3><span>{preview ? '2 / 2' : '1 / 2'}</span></div>
      {preview ? <>
        <p className="hint">{t('mcpImport.detected', { count: Object.keys(preview.incoming).length })}</p>
        <div className="mcp-import-results">{Object.entries(preview.incoming).map(([name, config]) => {
          const exists = Object.hasOwn(preview.expected, name)
          return <div key={name} className="mcp-import-row"><div><b>{name}</b><small>{config.command || publicMcpUrl(config.url)}</small></div>
            {exists ? <label><input type="checkbox" checked={replace.includes(name)} onChange={e => setReplace(list => e.target.checked ? [...list, name] : list.filter(n => n !== name))} disabled={busy} />{t('mcpImport.replace')}</label> : <span className="hint">{t('mcpImport.new')}</span>}
          </div>
        })}</div>
        <p>{t('mcpImport.summary', { added, replaced: replace.length, skipped: Object.keys(preview.incoming).length - added - replace.length })}</p>
        <p className="hint">{t('mcpImport.credentials')}</p>
      </> : <>
        <div className="field"><label htmlFor="mcp-import-json">{t('mcpImport.config')}</label><textarea id="mcp-import-json" ref={input} rows={10} value={draft.json} placeholder={placeholder} spellCheck={false} disabled={busy} onChange={e => onDraft({ ...draft, json: e.target.value })} /><div className="hint">{t('mcpImport.formats')}</div></div>
        {(needsName || draft.name) && <div className="field"><label htmlFor="mcp-import-name">{t('mcpImport.name')}</label><input type="text" id="mcp-import-name" value={draft.name} disabled={busy} onChange={e => onDraft({ ...draft, name: e.target.value })} /></div>}
      </>}
      {error && <p className="mcp-import-error" role="alert">{error}</p>}
      <div className="mcp-import-actions">{preview && <button className="btn ghost sm" disabled={busy} onClick={() => { setPreview(null); setError('') }}>{t('mcpImport.back')}</button>}<button className="btn ghost sm" disabled={busy} onClick={onClose}>{t('settings.btn.cancel')}</button><button className="btn primary sm" disabled={busy || (preview ? added + replace.length === 0 : !draft.json.trim())} onClick={() => void (preview ? save() : check())}>{t(preview ? 'mcpImport.save' : 'mcpImport.check')}</button></div>
    </div>
  </div>, document.body)
}
