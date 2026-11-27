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
| `penzor` | Forsion 云端(server microserver/remotesync;条件写 CAS)—— 实现住在 Forsion Extend 包,经 `backends.ts` 注册点接入;没装 Extend 就没有这一项 |
| `dropbox` | Dropbox(自研直连 REST v2;OAuth PKCE + refresh token,rev 条件写 CAS) |
| `gdrive` | Google Drive(自研直连 REST v3;桌面应用 OAuth 客户端 + PKCE + refresh token,权限 `drive.file`;无条件写,写前复查身份,见「上限」) |

Dropbox 授权 = 链接登录。App Key 来自 `fsDropbox.ts` 的 `FORSION_DROPBOX_APP_KEY`
(Forsion 官方应用;PKCE 公共客户端无 secret,随包发是官方做法)——**填了它用户就不用建应用**,
UI 收起 App Key 栏只留「连接 Dropbox」;为空则退回「用户自建应用 + 填 App Key」,
UI 也留了「改用自建 Dropbox 应用」的出口。用户自建的 key 落配置,官方 key 不落
(否则日后换 key 会被旧值盖住)。

点「连接」开系统浏览器,回调打回本机回环口
`http://localhost:53682/`(RFC 8252,端口写死因 Dropbox 要求 redirect_uri 与 App Console
登记值逐字相等),授权码自动回填;回环口起不来(被占/受限)自动降级为「页面显示授权码 + 手贴」。
state 校验必须保留——回环口本机任意进程都能打。

Google Drive 授权同样是链接登录,客户端来自 `fsGdrive.ts` 的 `FORSION_GDRIVE_CLIENT_ID` /
`FORSION_GDRIVE_CLIENT_SECRET`(Forsion 官方「桌面应用」客户端;Google 明说桌面客户端的 secret 不算机密,
但 token 端点仍要它)——为空则 UI 退回「自建客户端 + 填 ID 和 secret」。和 Dropbox 的差别:

- 回环地址 `http://127.0.0.1:<系统选的端口>/`:Google 对桌面客户端不校验回环端口,不用写死;
  Google 已关掉 OOB 手贴码,**没有手贴兜底**,回环起不来直接报 `loopback-unavailable`。
  授权 URL 带 `access_type=offline&prompt=consent`,重连也必拿到 refresh token。
- 权限 `drive.file`(免安全审计):**只看得到本客户端建的文件**。用户在网页版里手动拖进同步目录的文件同步不到;
  换客户端(自建 ↔ 官方、换一个自建)远端可见集整个变了 —— 指纹 `gdrive:<clientId>|<permissionId>|<目录>`
  带 client id,换了就作废基线走首次合流,绝不把「看不见」当「被删」。每台设备要用同一个客户端。
- 自建客户端的同意屏幕停在「测试」状态时,Google 发的 refresh token 7 天过期,要发布成正式版。
- 缺省远端目录 `Forsion-Vault`(在「我的云端硬盘」下;Drive 没有 App Folder 沙箱,空着会撒在根上)。
- 设置页改了自建客户端再保存,旧 refresh token 作废(它只对签发它的客户端有效),要重新连接。
- Drive 按 ID 寻址、同名可以并存:walk 一次平铺列出全部可见文件,内存里建「路径 → ID」。同名文件夹合并
  (两台并发首推各建了一个);同名文件按 createdTime→id 排,第一个占原路径,其余以
  `名 (conflict gdrive <文件 ID>).扩展名` 露出 —— 各自映射到自己的 ID,本地删掉这份副本 = 远端那份进回收站
  (派生 key 万一撞上真实文件名,整轮报 `gdrive-key-collision`,不静默吞掉一个 ID)。同名的空文件夹不挤占文件的路径。
  Google 文档类(不可下载)与名字带 `/` 的跳过;列表自报 `incompleteSearch` 一律当失败。下载后对清单的 sha256 / md5 校验,
  对不上(清单之后被改过)就报错、保留基线。
- 写入一律 resumable 会话(multipart 只适合 5MB 内);删除 = 移进 Drive 回收站;限流(429 / 403 rate limit)退避重试,
  内容 PUT 不重试(可能已落盘,重试会出重复文件)。walk 只读,远端目录不存在 = 空远端,第一次写才建。

同步方式(SyncOptions.direction,remotely-save 的 sync direction 对标):`both` 双向(默认);
`push` 仅上传 = 增量备份(不拉取、不传播删除,冲突以本地为准);`pull` 仅下载 = 增量还原
(不推送、不传播删除,冲突仍出本地副本)。单向模式绝不动被丢弃方向的基线,切回双向自然收敛。

出网:Dropbox / Google Drive 两个后端由宿主注入 `abortableFetch(net.fetch)`(`remotesyncIpc.ts` 的 `remoteFetch`),
走 Chromium 网络栈,认系统代理 / PAC / SOCKS —— 主进程 Node 全局 fetch 不认系统代理,国内开系统代理(非 TUN)时连不上。
包装补齐 net.fetch 与 Node fetch 的差别:不带默认会话的 cookie、不读也不写 HTTP 缓存、已 abort 的不再发;
abort 本身靠 net.fetch(实测等头 / 读体 / 上传途中都生效,上传被掐断后服务端收不到完整请求体),响应原样返回、不另缓冲。
后端本身不 import electron,单测照旧 stub 全局 fetch。升级 Electron 后跑 `npm run check:remotesync-netfetch`
(本机假服务 + 本机假代理,不出网)。S3 / WebDAV / 文件夹不在此列(国内服务为主,用的是各自的库)。

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
- **Google Drive 没有条件写**:v3 的 File 没有 etag,`files.update` 不认 If-Match。只能写前按 ID 复查身份
  (`id@headRevisionId` + 名字 + 父目录,放在发内容 / 回收请求的前一刻,限流重试的每一次都重新复查)、新建前按
  「全部同名父目录 + 名字」复查不存在 —— 窗口从「walk 到 push 整段」缩到「复查到写入一个往返」,
  不是原子的。窗口里另一台改了同一个文件,其版本会被盖掉(Drive 自己留了历史版本,可在网页版「管理版本」找回);
  两台同时新建同名文件不会互相覆盖,而是并存成两份,下一轮以冲突 key 露出。
- 冲突不做 diff3 智能合并(M2:本地存基线 blob 后接 `node-diff3`);M1 = 冲突副本。
- folder 后端身份 = mtime+size(同毫秒同大小的外部改动检测不到;要更强换内容 hash)。
- 空目录不同步(文件驱动,拉取时按需建父目录)。
- 大文件按 `maxFileMB` 跳过(默认 100MB),WebDAV 整文件 PUT 无分块。
- 端到端加密未做(M2:移植上游 Apache 的 openssl/rclone 兼容加密层)。

## 边界

- 云同步并发回归：在 `desktop/` 运行 `npm run test:cloud-consistency`。覆盖上传期间编辑、仅上传 CAS、云桥白板/数据库冲突和正文超时；使用临时文件及合成 HTTP，不连接生产账号。
- Cloud consistency regression: run `npm run test:cloud-consistency` from `desktop/`. Tests use temporary files and synthetic HTTP responses; no production account is accessed.

- 本目录**零依赖宿主**:不 import electron 与 desktop 其他模块,纯 Node + npm 依赖,
  可独立单测(`*.test.ts`,vitest)。
- 宿主接线在 `electron/remotesyncIpc.ts`:配置持久化、调度、IPC、vault 根解析
  (禁止把云镜像目录设为同步根;entrySync 绑定目录自动加入忽略,避免双引擎抢管辖)。
