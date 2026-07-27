# NOTICE — 第三方代码来源与许可声明

本目录(`electron/remotesync/`)是 Forsion Desktop 的「本地库远程同步」层,**自包含、独立维护**。
其中部分文件改编自开源项目 **remotely-save**(Obsidian 同步插件):

- 上游仓库:https://github.com/remotely-save/remotely-save
- 改编基准 commit:`34db181af002f8d71ea0a87e7965abc57b294914`(2024-11-10)
- 上游许可:上游仓库 `src/` 目录以 **Apache License 2.0** 发布(见本目录 LICENSE);
  上游 `pro/` 目录为 PolyForm Strict 1.0.0(Source Available,禁止分发与衍生)。

## 合规边界(重要)

**本目录未使用、未改编、未参考上游 `pro/` 目录(PolyForm Strict)下的任何代码**,包括其
同步算法(`pro/src/sync.ts`)、冲突处理(`pro/src/conflictLogic.ts`)与各 OAuth 后端。
本目录中的三方对账 / 冲突副本 / 删除防护等同步核心逻辑为 Forsion 自研
(与 `electron/amadeus/sync/reconcile.ts` 同源的自研演进),仅在产品功能层面对标。

## 逐文件来源

改编自 remotely-save `src/`(Apache-2.0,按 License 4(b) 声明:文件均经修改,
主要修改为:去除 Obsidian API 依赖改为 Node.js 运行时、TypeScript 风格与接口精简、
去除分块上传等未采用特性):

| 本目录文件 | 上游来源 |
|---|---|
| `fsS3.ts` | `src/fsS3.ts` |
| `fsWebdav.ts` | `src/fsWebdav.ts` |
| `types.ts`(RemoteFs 接口形状) | `src/fsAll.ts`、`src/baseTypes.ts`(Entity) |

Forsion 自研(不含上游代码):`decide.ts`、`engine.ts`、`prevSync.ts`、`ignore.ts`、
`fsLocal.ts`、`fsPenzor.ts`、`fsDropbox.ts`(直连 Dropbox 公开 REST v2 API 实现,
未使用、未参考上游任何 Dropbox 相关代码)及全部测试文件。

## 维护规则

- 本目录不得 import Forsion Desktop 其他模块(electron/frontend 均不可);只允许 Node 内置模块与 package.json 里的 npm 依赖。宿主经 `electron/remotesyncIpc.ts` 接线。
- 若未来从上游同步改动,只能取 `src/`(Apache)部分,并更新本文件的基准 commit 与文件表。
