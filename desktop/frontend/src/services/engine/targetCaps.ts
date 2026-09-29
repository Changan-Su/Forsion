/**
 * 按目标求值的能力旗标(P1-K6 §3.1 / §3.7)。从 `window.tangu` 全局旗标(remoteCaller / hostFiles)改为「这条请求发往的
 * 那台引擎能做什么」:手机把整端切到「我的电脑」后,审批卡要按远端规矩收起改参数 / 总允许,deny-remote 的路由
 * 不再发出去(服务层预判,直接给本地化 LOCAL_ONLY)。
 *
 * 取值(unit 的四个 false 与 desktop/electron/engineRoutes.generated.ts 的 deny-remote 行一一对应,targetCaps.test 钉住):
 *   local    —— 本机引擎:全有,只是审批不是远端;hostFs 只在 managed(external 连的是别处的引擎,与今天 isHostCapable 一致)。
 *   cloud    —— web / 手机的 home(云网关):维持今天行为,没有 host FS / 外部引擎。
 *   unitPage —— 设备页的 home:今天的 window.tangu.remoteCaller / hostFiles 原样搬进来,其余维持今天行为。
 *   unit     —— 经 hub 的「我的电脑」:远端审批、有 host FS(那台电脑的真文件系统;名册 caps 接进来之前按乐观 true,
 *               读失败由调用方降级);硬删 / 回退 / 检查点恢复 / 整对象 PUT 配置 / 工作区删除 / 外部引擎都不可用;不能直链资源
 *               (隧道 cookie 对 https://localhost 是跨站,<img src> 不带凭据)。
 */
import type { EngineTarget, TargetRef, TargetVia } from './target'
import { homeVia, hostDesktopMode } from './targets'

export interface TargetCaps {
  /** 审批卡禁改参数 / 禁「总允许」(C9:引擎对远端调用方不兑现这两样)。 */
  remoteApprover: boolean
  /** 引擎有真 host FS(可 host 执行、可读 host 文件)。 */
  hostFs: boolean
  /** DELETE /agent/sessions/:id */
  hardDeleteSession: boolean
  /** POST /agent/sessions/:id/messages/delete(回退) */
  rewind: boolean
  /** POST /agent/sessions/:id/checkpoints/restore */
  checkpointRestore: boolean
  /** PUT /agent/sessions/:id/config;false → 一律 PATCH */
  putSessionConfig: boolean
  /** POST /agent/workspace/delete */
  workspaceDelete: boolean
  /** /agent/engines*(外部引擎 ACP) */
  externalEngines: boolean
  /** workspaceDownloadUrl 可直接当 <img src>;false → 缩略图 / 预览一律 blob 拉取 */
  directAssetUrl: boolean
}

const ALL: Omit<TargetCaps, 'remoteApprover' | 'hostFs'> = {
  hardDeleteSession: true, rewind: true, checkpointRestore: true, putSessionConfig: true, workspaceDelete: true, externalEngines: true, directAssetUrl: true,
}

export function capsForVia(via: TargetVia): TargetCaps {
  switch (via) {
    case 'local':
      return { ...ALL, remoteApprover: false, hostFs: hostDesktopMode() === 'managed' }
    case 'cloud':
      return { ...ALL, remoteApprover: false, hostFs: false, externalEngines: false }
    case 'unitPage': {
      const w = typeof window !== 'undefined' ? window.tangu : undefined
      return { ...ALL, remoteApprover: !!w?.remoteCaller, hostFs: w?.hostFiles !== false, externalEngines: false }
    }
    case 'unit':
      return {
        remoteApprover: true, hostFs: true,
        hardDeleteSession: false, rewind: false, checkpointRestore: false, putSessionConfig: false, workspaceDelete: false, externalEngines: false, directAssetUrl: false,
      }
  }
}

export function targetCaps(t: EngineTarget): TargetCaps {
  return capsForVia(t.via)
}

/** 不铸目标也能判(审批卡在没装宿主的单测里也要渲染):unit 位置 = unit 能力;home = 按端现算的来路。 */
export function capsForRef(ref: TargetRef): TargetCaps {
  return capsForVia(ref.kind === 'unit' ? 'unit' : homeVia())
}
