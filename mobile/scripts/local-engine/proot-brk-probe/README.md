# PRoot brk 复现手段（#928 B1）

现象：Android 15 arm64 模拟器上，PRoot 里的 node 起引擎时约四分之一以 glibc `double free or corruption (out)` 退出。
根源在 PRoot 的堆模拟（`syscall/heap.c`），修法见 `mobile/android/native/proot/patches/proot-0005-no-heap-emulation.patch`。

## 文件

| 文件 | 是什么 |
|---|---|
| `probe.sh` | 在设备上循环跑 node / 引擎，按层对照（直接跑 / PRoot / App 身份），计 `double free` 次数 |
| `app-loop.cjs` | 经原生插件循环 `start()` / `stop()`，统计每次用了几次拉起，和 logcat 里的失败原文 |
| `heap-env-switch.patch` | 实验用：给 `heap.c` 加环境变量 `PROOT_NO_HEAP_EMULATION=1` 开关，打在补丁 1–4 之上（不和 0005 一起用） |

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
