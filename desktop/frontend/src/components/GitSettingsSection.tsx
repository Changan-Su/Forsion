import { useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getGitSettings, setGitSettings } from '../services/backendService'
import type { GitSettings, TanguDesktopConfig } from '../types'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'

registerMessages({
  'gitSettings.title': { zh: 'Git', en: 'Git' },
  'gitSettings.description': {
    zh: '项目详情「Git」页里的提交、新建分支和推送按这里的设置来；Agent 替你建分支或写提交信息时也会照做。',
    en: 'The commit, new branch and push actions on the Git page of project details follow these settings. Agents follow them too when they create a branch or write a commit message for you.',
  },
  'gitSettings.prefix': { zh: '分支前缀', en: 'Branch prefix' },
  'gitSettings.prefixHint': {
    zh: '新建分支时预填在名字前面，Agent 自己起分支名时也会带上。留空就不加前缀。',
    en: 'Filled in before the name when you create a branch, and used when an agent names a branch itself. Leave it empty for no prefix.',
  },
  'gitSettings.prefixInvalid': {
    zh: '前缀只能包含字母、数字、. _ / -，最多 40 个字符。',
    en: 'The prefix can only contain letters, digits, . _ / and -, up to 40 characters.',
  },
  'gitSettings.instructions': { zh: '提交说明', en: 'Commit instructions' },
  'gitSettings.instructionsHint': {
    zh: '生成提交信息时一并交给模型，Agent 替你提交时也会照做。最多 1000 个字符。',
    en: 'Given to the model when it writes a commit message, and followed by agents when they commit for you. Up to 1000 characters.',
  },
  'gitSettings.instructionsPlaceholder': {
    zh: '例如：用中文写，标题以 feat: 或 fix: 开头',
    en: 'For example: Follow Conventional Commits and keep the subject under 50 characters',
  },
  'gitSettings.lease': { zh: '推送时允许改写远端历史', en: 'Allow rewriting remote history when pushing' },
  'gitSettings.leaseHint': {
    zh: '开启后推送会带上 --force-with-lease 和 --force-if-includes：修改过上一次提交这类改写了历史的分支也能推上去；远端有你本地还没合进来的提交时仍会拒绝。关闭时推送从不改写远端历史。',
    en: 'Pushes then use --force-with-lease and --force-if-includes, so a branch whose history you rewrote (for example by amending the last commit) can still be pushed. The push is refused if the remote has commits you have not integrated locally. When off, pushes never rewrite remote history.',
  },
  'gitSettings.reset': { zh: '恢复默认', en: 'Reset to default' },
  'gitSettings.readonly': {
    zh: '当前连接的引擎不在这台电脑上，Git 设置只能在引擎所在的电脑上修改。',
    en: 'The connected engine is not on this computer, so Git settings can only be changed on the computer that runs it.',
  },
  'gitSettings.unavailable': {
    zh: '当前连接的引擎不支持 Git 设置，更新引擎后再试。',
    en: 'The connected engine does not support Git settings yet. Update it and try again.',
  },
})

/** 与引擎 gitSettings.ts 同一把闸;客户端先拦,免得把一个必然被拒的值发过去。 */
const PREFIX_OK = /^[A-Za-z0-9._/-]{0,40}$/

/**
 * 设置 → 通用 → Git:引擎 config.json 的 git 段(GET / PUT /agent/git-settings)。
 * 文本框失焦才落盘(别每个字符打一次后端),开关立即落盘;对下一次动作 / 下一个 run 生效。
 */
export function GitSettingsSection({ cfg }: { cfg: TanguDesktopConfig }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ settings: GitSettings; defaults: GitSettings; writable: boolean } | null>(null)
  const [prefix, setPrefix] = useState('')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const saveSeq = useRef(0)

  useEffect(() => {
    let alive = true
    getGitSettings(cfg)
      .then((r) => {
        if (!alive) return
        setState(r); setPrefix(r.settings.branchPrefix); setInstructions(r.settings.commitInstructions)
      })
      .catch(() => { if (alive) setUnavailable(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换引擎地址时重取;cfg 对象每次渲染可能是新引用
  }, [cfg.backendUrl])

  if (unavailable) return <SettingsPanel icon={<GitBranch size={16} />} title={t('gitSettings.title')} description={t('gitSettings.unavailable')} />
  if (!state) return null
  const locked = !state.writable
  // ⚠️草稿只回写「这次保存的那一项、且框里还是发出去的那个值」:前缀的响应可能在用户已经开始写提交说明之后才回来,
  //   整份回写会把正在打的字冲掉(台架 6n 把这个时序钉成了必现);同一个框保存途中又改了,也留着他新打的字。
  //   开关等整份状态只认最后一次保存的响应,乱序回来的旧响应不许把显示倒回去。
  const save = async (patch: { [K in keyof GitSettings]?: GitSettings[K] | null }) => {
    const seq = ++saveSeq.current
    try {
      const settings = await setGitSettings(cfg, patch)
      if (seq === saveSeq.current) setState((s) => (s ? { ...s, settings } : s))
      const sent = (v: unknown, cur: string) => v == null || cur.trim() === v
      if ('branchPrefix' in patch) setPrefix((cur) => (sent(patch.branchPrefix, cur) ? settings.branchPrefix : cur))
      if ('commitInstructions' in patch) setInstructions((cur) => (sent(patch.commitInstructions, cur) ? settings.commitInstructions : cur))
      setError('')
    } catch (e: any) { setError(e?.message || String(e)) }
  }
  const prefixBad = !PREFIX_OK.test(prefix.trim())
  const commitPrefix = () => { const v = prefix.trim(); if (!prefixBad && v !== state.settings.branchPrefix) void save({ branchPrefix: v }) }
  const commitInstructions = () => { const v = instructions.trim(); if (v !== state.settings.commitInstructions) void save({ commitInstructions: v }) }

  return <SettingsPanel icon={<GitBranch size={16} />} title={t('gitSettings.title')} description={t(locked ? 'gitSettings.readonly' : 'gitSettings.description')} className="git-settings-panel">
    <div className="field">
      <label htmlFor="git-settings-prefix">{t('gitSettings.prefix')}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input id="git-settings-prefix" type="text" style={{ flex: 1, minWidth: 0 }} value={prefix} disabled={locked} spellCheck={false} maxLength={40}
          onChange={(e) => setPrefix(e.target.value)} onBlur={commitPrefix}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        <button className="btn ghost sm" disabled={locked || state.settings.branchPrefix === state.defaults.branchPrefix} onClick={() => void save({ branchPrefix: null })}>{t('gitSettings.reset')}</button>
      </div>
      <div className="hint">{t(prefixBad ? 'gitSettings.prefixInvalid' : 'gitSettings.prefixHint')}</div>
    </div>
    <div className="field">
      <label htmlFor="git-settings-instructions">{t('gitSettings.instructions')}</label>
      <textarea id="git-settings-instructions" rows={3} value={instructions} disabled={locked} maxLength={1000}
        placeholder={t('gitSettings.instructionsPlaceholder')} onChange={(e) => setInstructions(e.target.value)} onBlur={commitInstructions} />
      <div className="hint">{t('gitSettings.instructionsHint')}</div>
    </div>
    <SettingsRow label={t('gitSettings.lease')} description={t('gitSettings.leaseHint')}
      control={<SettingsSwitch checked={state.settings.forceWithLease} disabled={locked} label={t('gitSettings.lease')} onChange={(v) => void save({ forceWithLease: v })} />} />
    {error && <div className="hint model-catalog-error" role="alert">{error}</div>}
  </SettingsPanel>
}
