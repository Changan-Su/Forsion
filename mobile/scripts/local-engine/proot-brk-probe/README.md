# PRoot brk 复现手段（#928 B1）

现象：Android 15 arm64 模拟器上，PRoot 里的 node 起引擎时约四分之一以 glibc `double free or corruption (out)` 退出。
触发点是 PRoot 的堆模拟（`syscall/heap.c`）：同一个二进制里只关掉它就不崩，具体哪一步出错没有查到。修法见 `mobile/android/native/proot/patches/proot-0005-no-heap-emulation.patch`。

## 文件

| 文件 | 是什么 |
|---|---|
| `probe.sh` | 在设备上循环跑 node / 引擎，按层对照（直接跑 / PRoot / App 身份），计 `double free` 次数 |
| `app-loop.cjs` | 经原生插件循环 `start()` / `stop()`，统计每次用了几次拉起，和 logcat 里的失败原文 |
| `heap-env-switch.patch` | 实验用：给 `heap.c` 加环境变量 `PROOT_NO_HEAP_EMULATION=1` 开关，打在补丁 1–4 之上（不和 0005 一起用） |
| `guest-tools.sh` | 用 App 身份（run-as）在装好的环境里跑 bash / apt / dpkg / git / 大堆 node；run-as 没有网络，apt 只能看到解析失败 |
| `guest-tools-app.cjs` | 同样几项，经调试包的 `shell` 调用在 App 自己的进程里跑（有网络），另加 npm install；调用先发出去再轮询结果 |

## 用法

```bash
adb push probe.sh /data/local/tmp/b1-dev.sh
# App 的 nativeLibraryDir:pm dump com.forsion.tangu | grep codePath= → <codePath>/lib/arm64
echo "<codePath>/lib/arm64" | adb shell "cat > /data/local/tmp/b1-libdir"
# App 身份,装好的环境,起整个引擎 20 次
adb shell "run-as com.forsion.tangu sh /data/local/tmp/b1-dev.sh runas engine 20"
# 把装好的环境拷给 shell 用户,做不经 PRoot / 换 PRoot 二进制的对照
adb exec-out run-as com.forsion.tangu tar -cf - -C files/local-engine rootfs | adb shell "mkdir -p /data/local/tmp/b1full && tar -xf - -C /data/local/tmp/b1full"
adb shell "sh /data/local/tmp/b1-dev.sh direct-full engine 20"
adb shell "sh /data/local/tmp/b1-dev.sh shell-full engine 20"
adb shell "PB=/data/local/tmp/<另一个 libproot.so> sh /data/local/tmp/b1-dev.sh shell-full engine 20"
```

`direct` / `proot-shell` 两档用迷你 root（`/data/local/tmp/b1root`：从 base 层抽出 node 和 glibc 的几个库，再补 `lib -> usr/lib` 和 `usr/lib/ld-linux-aarch64.so.1` 两个链接）。

## 11-28 的结果（模拟器 API 35 arm64，6.6 内核）

| 跑法 | 负载 | 崩 / 次数 |
|---|---|---|
| shell，迷你 root，不经 PRoot | `node -e` | 0/100 |
| shell，迷你 root，PRoot | `node -e` | 0/100 |
| App 身份，PRoot | `node -e` | 0/100 |
| shell，完整环境，不经 PRoot | 整个引擎 | 0/20 |
| shell，完整环境，原版 PRoot | 整个引擎 | 5/20 |
| App 身份，原版 PRoot | 整个引擎 | 4/20 |
| shell，实验版 PRoot，`PROOT_NO_HEAP_EMULATION=1` | 整个引擎 | 0/30 |
| shell，同一实验版，堆模拟开着 | 整个引擎 | 6/20 |
| shell，原版 PRoot，`PROOT_NO_SECCOMP=1`（不走 seccomp 加速，所有系统调用都经 ptrace） | 整个引擎 | 1/15 |

跑的时候主机上还有别的任务，负载在 6 到 40 之间。

## 补丁 5 之后（11-28，同一台模拟器）

| 跑法 | 启动器 | 结果 |
|---|---|---|
| `app-loop.cjs`，起停 40 轮，间隔 0 | 补丁 5 | 40/40 第一次拉起就健康，0 次崩溃；就绪中位 4.3 s，最长 18.7 s |
| `app-loop.cjs`，起停 30 轮，间隔 0（对照，紧接着跑） | 原版（补丁 1–4） | 37 次拉起里 8 次崩在 `double free or corruption (out)`；有 1 轮两次都崩，`start()` 失败 |
| 按评审改完的 `app-loop.cjs`，12 轮 | 补丁 5 | 12/12，0 崩 |
| 同上（对照） | 原版 | 16 次拉起 6 次崩，2 轮 `start()` 失败，退出码 1 |
| `guest-tools-app.cjs` | 补丁 5 | bash、git（`fsck --strict` 干净）、node 200 MB 堆、npm install 都正常；apt 能下载和解包，jq 能跑；dpkg 停在 unpacked（写不了 `status-old` 硬链接，`--link2symlink` 关着时本来就这样，和补丁无关） |

`app-loop.cjs` 按 `engine start attempt N failed` 数失败的拉起，`doubleFreeSpawns` 数引擎自己输出的 `double free` 那行（失败摘要只带最后几行，不一定重复它）。对照那轮是改脚本前跑的，当时按行数算是 16 行，正好 8 次 × 2 行。
