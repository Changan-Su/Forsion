import React from 'react'
import { registerMessages, useI18n } from '../i18n'
import type { HostSandboxConfig } from '../../../shared/hostSandboxConfig'

registerMessages({
  'settings.hostSandbox.label': { zh: '本地命令与文件沙箱', en: 'Local command and file sandbox' },
  'settings.hostSandbox.off': { zh: '关闭（直接执行）', en: 'Off (direct execution)' },
  'settings.hostSandbox.workspace': { zh: '仅工作区可写', en: 'Workspace writes only' },
  'settings.hostSandbox.readOnly': { zh: '只读', en: 'Read-only' },
  'settings.hostSandbox.network': { zh: '沙箱内网络', en: 'Sandbox network' },
  'settings.hostSandbox.deny': { zh: '禁止联网', en: 'Block network access' },
  'settings.hostSandbox.allow': { zh: '允许联网（含本机服务）', en: 'Allow network (including local services)' },
  'settings.hostSandbox.hint': { zh: '限制命令和文件工具的写入范围；仍允许读取本机文件，不提供凭据保密隔离。macOS 使用系统沙箱，Linux 需要 bubblewrap；Windows 暂不支持。隔离不可用时会拒绝执行。', en: 'Limits writes by commands and file tools; local files and credentials remain readable. Uses the macOS system sandbox or bubblewrap on Linux. Windows is not supported yet. Execution is refused if isolation is unavailable.' },
  'settings.hostSandbox.limits': { zh: '启用后，Hooks、MCP、原生插件和外部引擎停用。文件搜索与补丁请通过 run_bash 执行。保存并重启后生效。', en: 'Enabling this disables Hooks, MCP, native plugins and external engines. Search and patch files through run_bash. Takes effect after saving and restarting.' },
})

export function HostSandboxSettings({ value, onChange }: {
  value?: HostSandboxConfig
  onChange(value: HostSandboxConfig): void
}) {
  const { t } = useI18n()
  const policy = value ?? { mode: 'off', network: 'deny' }
  return <div className="field" data-testid="host-sandbox-settings">
    <div className="field-row">
      <div className="field">
        <label htmlFor="host-sandbox-mode">{t('settings.hostSandbox.label')}</label>
        <select id="host-sandbox-mode" value={policy.mode} onChange={e => onChange({ ...policy, mode: e.target.value as HostSandboxConfig['mode'] })}>
          <option value="off">{t('settings.hostSandbox.off')}</option>
          <option value="workspace-write">{t('settings.hostSandbox.workspace')}</option>
          <option value="read-only">{t('settings.hostSandbox.readOnly')}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="host-sandbox-network">{t('settings.hostSandbox.network')}</label>
        <select id="host-sandbox-network" disabled={policy.mode === 'off'} value={policy.network} onChange={e => onChange({ ...policy, network: e.target.value as HostSandboxConfig['network'] })}>
          <option value="deny">{t('settings.hostSandbox.deny')}</option>
          <option value="allow">{t('settings.hostSandbox.allow')}</option>
        </select>
      </div>
    </div>
    <p className="hint">{t('settings.hostSandbox.hint')}</p>
    {policy.mode !== 'off' && <p className="hint">{t('settings.hostSandbox.limits')}</p>}
  </div>
}
