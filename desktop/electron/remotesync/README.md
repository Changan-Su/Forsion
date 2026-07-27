# remotesync — 本地库远程同步层(remotely-save 式)

把 Amadeus **本地库**(磁盘目录)与一个远程存储做**非实时的双向同步**(手动 / 定时),
对标 Obsidian 插件 remotely-save 的产品形态。与「云端模式」(Penzor 实时镜像,
`electron/amadeus/sync/`)是两套机制:云端模式=文件本体在服务器;本层=文件本体在本地,
远端只是一个哑存储。

## 后端(M1)

| kind | 说明 |
|---|---|
| `folder` | 本地/外接目录(U 盘、NAS 挂载点);也是测试用假远端 |
| `s3` | S3 兼容对象存储(AWS/阿里 OSS/腾讯 COS/MinIO/R2) |
| `webdav` | WebDAV(坚果云/Nextcloud/自建) |
| `penzor` | Forsion 云端(server microserver/remotesync;条件写 CAS) |
| `dropbox` | Dropbox(自研直连 REST v2;OAuth PKCE + refresh token,rev 条件写 CAS) |

同步方式(SyncOptions.direction,remotely-save 的 sync direction 对标):`both` 双向(默认);
`push` 仅上传 = 增量备份(不拉取、不传播删除,冲突以本地为准);`pull` 仅下载 = 增量还原
(不推送、不传播删除,冲突仍出本地副本)。单向模式绝不动被丢弃方向的基线,切回双向自然收敛。

## 同步语义(自研核心,见 NOTICE.md 合规边界)

- **三方对账**:本地内容 hash ↔ 基线(prevSync,上次收敛点)↔ 远端身份(etag 或 mtime+size)。
  单侧变更定向传播;双侧都变 = 冲突。
- **冲突绝不静默覆盖**:本地版存为 `Name (conflict YYYY-MM-DD HHmm).ext`,远端版落原路径
  (与云端模式同一取向,多设备一轮收敛)。哑后端无条件写(CAS),并发写窗口客观存在,
  靠冲突副本兜底。
- **缺失≠删除**:删除判定必须有基线佐证(prev 有 + 一侧无);远端列表为空而基线≥5 条
  → **硬中止**(`remote-empty-suspicious`,不可经删除闸确认放行;远端确已重置想以本地为准,
  换个远端目录/前缀走首次合流即可。基线 <5 条时远端空是小库正常态,不拦,损失有界且走回收站)。质量删除闸 `shouldTripMassDelete`
  (≥200 绝对值,或追踪数≥5 且删除数≥max(5, 一半);tracked 只数未被忽略的基线)
  → 挂起等用户确认;确认绑定「根+后端指纹」作用域,改了配置旧确认作废。
- **远端 key 不可信**:`isSafeKey` 拒绝 `../`/绝对路径/反斜杠/NUL/空段,`absOf` 二次校验
  解析路径不逃出根。
- **本地删除走回收站**(宿主注入 `deleteLocalFile`,默认 `fs.rm`)。
- 基线带 `remoteFingerprint`(后端类型+地址+bucket/目录),换目标自动作废基线,
  按首次合流处理(两侧并集,同名不同内容出冲突副本),绝不误删。

## 上限(有意为之,升级路径)

- **远端写无条件写(无 CAS)**:walk 与 push 之间另一设备写同 key,其版本会被盖掉且不留副本
  (与 remotely-save 同款窗口;真解 = M2 能力探测后用 WebDAV If-Match / 支持条件写的 S3)。
  非并发场景(单人多设备错峰)不受影响,三方对账 + 冲突副本兜住绝大多数分叉。
- 冲突不做 diff3 智能合并(M2:本地存基线 blob 后接 `node-diff3`);M1 = 冲突副本。
- folder 后端身份 = mtime+size(同毫秒同大小的外部改动检测不到;要更强换内容 hash)。
- 空目录不同步(文件驱动,拉取时按需建父目录)。
- 大文件按 `maxFileMB` 跳过(默认 100MB),WebDAV 整文件 PUT 无分块。
- 端到端加密未做(M2:移植上游 Apache 的 openssl/rclone 兼容加密层)。

## 边界

- 本目录**零依赖宿主**:不 import electron 与 desktop 其他模块,纯 Node + npm 依赖,
  可独立单测(`*.test.ts`,vitest)。
- 宿主接线在 `electron/remotesyncIpc.ts`:配置持久化、调度、IPC、vault 根解析
  (禁止把云镜像目录设为同步根;entrySync 绑定目录自动加入忽略,避免双引擎抢管辖)。
