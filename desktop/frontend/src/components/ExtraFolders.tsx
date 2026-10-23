/**
 * 新对话的「额外文件夹」:项目胶囊后面的一枚「添加文件夹」,加进来的排成可移除的胶囊(对齐 Claude 输入框上方那一排)。
 *
 * 项目(cwd)不变。加进来的文件夹与项目目录同等读写、不另弹越界审批,并写进 Agent 的环境说明 —— 都是引擎现成的
 * extraRoots(tangu-agent 的 fsPolicy.writableRoots + promptSections.hostEnvSection),这里只是把入口放到会话建出来之前:
 * 写进新对话草稿(newChatCfg.extraRoots),随第一条消息建会话时落进会话配置,草稿里那份随即清掉(只给这一个会话)。
 * 会话建好之后在右侧任务概览的「工作范围」里增删。
 *
 * 只在新会话会建成**这台电脑上的本机会话**时出现:云端 / 不在项目中 / Chat / 建在别的电脑上都没有本机文件夹可加。
 */
import React, { useEffect, useRef } from 'react'
import { Folder, FolderPlus, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { newSessionPreset, resolveNewSessionWorkspace } from '../tangu/store/tanguSlice'
import { currentPlatform } from '../services/platform'
import { useEngineFocus } from '../services/engine/targets'
import { projectName } from '../views/coding/studioModel'

registerMessages({
  'input.folders.add': { zh: '添加文件夹', en: 'Add folder' },
  'input.folders.addHint': { zh: '添加文件夹：Agent 在里面的读写权限与项目目录相同', en: 'Add a folder: the agent gets the same access as in the project folder' },
  'input.folders.remove': { zh: '移除 {name}', en: 'Remove {name}' },
})

/** 引擎每个 run 最多认 8 个额外根(agentLoop),系统还会把笔记库并在末尾(withAmadeusWorkspace)—— 留一个位置给它。 */
export const MAX_EXTRA_FOLDERS = 7

const NONE: string[] = []

export function ExtraFolders(): React.ReactElement | null {
  const { t } = useI18n()
  const cwd = useApp((s) => {
    const platform = currentPlatform()
    const ws = resolveNewSessionWorkspace(s, platform)
    return newSessionPreset(s.sessionMode, ws, platform) !== 'chat' && ws.kind === 'local' && ws.path ? ws.path : null
  })
  const roots = useApp((s) => s.newChatCfg.extraRoots) || NONE
  const remote = useEngineFocus((s) => s.ref.kind === 'unit')
  const pick = window.tangu?.pickDirectory
  // 这一栏还在不在:系统选目录框开着的时候第一条消息可能已经发出去、会话已建好(这一栏随之卸掉)——
  // 晚回来的选择不许再写进草稿,否则它落不到刚建的会话上,却会带进下一个新对话。
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (!cwd || remote || !pick) return null

  const write = (next: string[]): void => useApp.getState().setExecConfig({ extraRoots: next }, null)
  const add = (): void => {
    void pick().then((dir) => {
      const cur = useApp.getState().newChatCfg.extraRoots || []
      if (!mounted.current || !dir || dir === cwd || cur.includes(dir) || cur.length >= MAX_EXTRA_FOLDERS) return // 这一栏已经不在 / 取消 / 就是项目目录 / 已加过
      write([...cur, dir])
    })
  }
  return (
    <>
      {roots.map((p) => (
        <span key={p} className="composer-chip project-pill extra-folder" title={p} data-extra-folder={p}>
          <Folder size={13} />
          <span className="project-pill-name">{projectName(p)}</span>
          <button
            type="button"
            className="extra-folder-x"
            title={t('input.folders.remove', { name: projectName(p) })}
            aria-label={t('input.folders.remove', { name: projectName(p) })}
            onClick={() => write((useApp.getState().newChatCfg.extraRoots || []).filter((x) => x !== p))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {roots.length < MAX_EXTRA_FOLDERS && (
        <button
          type="button"
          className="composer-chip project-pill extra-folder-add"
          title={t('input.folders.addHint')}
          aria-label={t('input.folders.add')}
          data-extra-folder-add
          onClick={add}
        >
          <FolderPlus size={13} />
        </button>
      )}
    </>
  )
}
