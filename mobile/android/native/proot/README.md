# 本机引擎启动器（PRoot）

「这台手机」本机引擎（第 1 期）在 Android 上用 PRoot 跑一份 Ubuntu 用户态环境，Tangu 引擎（Node）在里面运行。
本目录是启动器的来源、补丁与构建脚本；产物在 `app/src/localEngine/jniLibs/arm64-v8a/`。

| 文件 | 是什么 | 许可 |
|---|---|---|
| `libproot.so` | PRoot 5.4.0 + 下面 4 个补丁，talloc 2.4.3 静态链接 | PRoot：GPL-2.0-or-later；talloc：LGPL-3.0-or-later |
| `libproot_loader.so` | PRoot 的 loader（静态、`-nostdlib`） | GPL-2.0-or-later |

名字以 `lib…so` 结尾只是为了让安装器把它们解到 `nativeLibraryDir`（应用私有数据目录不让 exec，SELinux）；
它们是**独立的可执行程序**，由 `LocalEngineProcess` 以子进程启动，**不与任何 App 代码链接**（没有 JNI、没有 `System.loadLibrary`）。

## 构建

```bash
mobile/android/native/proot/build-proot.sh          # 重建并覆盖 jniLibs 里的两个文件
mobile/android/native/proot/build-proot.sh --check  # 重建后比对 sha256，不覆盖；对不上退出 1
```

- 源码钉在 `sources.lock`（URL + sha256），NDK 钉 `28.2.13676358`、API 30，`-ffile-prefix-map` 去掉路径 → 可复现。
- 构建方式改编自 Mika 的 `tools/sandbox/build-native.sh`（Apache-2.0，https://github.com/wangzan101/mika）：同一份源码、补丁、NDK 与参数，产物与 Mika 的预编译文件逐字节一致。Mika 自己的启动器（`libmikarun.so`）不构建、不随包。
- 当前提交的产物：

| 文件 | sha256 |
|---|---|
| `libproot.so` | `3184f54e363b560f128ce888c69d434fa6bfe80293c9fff47108456e79e48fe2` |
| `libproot_loader.so` | `a73384d2f78b535936401ddee33909ae91966812e56437a16486934e0faa588c` |

### 补丁（`patches/`，来自 Mika）

1. `proot-0001-exitkill.patch` — 跟踪时加 `PTRACE_O_EXITKILL`：PRoot 自己被杀（App 被杀、停止时的 SIGKILL）时，内核连带杀掉它跟踪的整棵进程树，不留孤儿。
2. `proot-0002-seccomp-trap-enosys.patch` — Android 给 App 的 seccomp 过滤器对 PRoot 不认识的系统调用（`io_uring_*`、`clone3`、`faccessat2`、`epoll_pwait2`、`rseq`）发 SIGSYS；补丁把它改成返回 `-ENOSYS`，让调用方走自己的回落（`faccessat2` 只带 `AT_EACCESS` 时改发 `faccessat`）。
3. `proot-0003-arm64-new-path-syscalls.patch` — arm64 上较新的带路径系统调用（`openat2`、`faccessat2`、`fchmodat2`、`execveat`、`open_tree`、`move_mount`、`*xattrat` 等）也做路径翻译（不翻译的话它们会绕过 guest 根目录）。
4. `proot-0004-link2symlink-fstat-nonfile.patch` — `--link2symlink` 下 `fstat` 管道 / socket 这类不指向文件的描述符时不再出错，并正确去掉 ` (deleted)` 后缀。

## 只在测试渠道的包里带

- Gradle 开关：`-PlocalEngine` 或环境变量 `ANDROID_LOCAL_ENGINE=1` 时，`src/localEngine/jniLibs` 才并进主包，同时打开
  `extractNativeLibs`（`useLegacyPackaging`）、启用前台服务 `LocalEngineService`。不带开关的包里没有 PRoot，「这台手机」也不出现。
- CI（`build-desktop.yml` 的 Build APK）：tag 是测试渠道（`release-channel.mjs --test-channel <tag>` 输出 1，即预发布 tag）时才带。
  正式渠道比测试渠道晚一个版本再带。
- 环境包下载地址：`-PlocalEngineManifest=<https URL>` 或 `ANDROID_LOCAL_ENGINE_MANIFEST`（CI 读仓库变量 `LOCAL_ENGINE_MANIFEST_URL`）。
  没配地址的包里「这台手机」不出现。环境包本身由 `mobile/scripts/local-engine/build-env.sh` 生成（出包流水线是后续工作）。

## GPL：发版附源码包

带启动器的每个发布（目前只有测试渠道的预发布）在 GitHub Release 上另附一个源码包，做法：

```bash
# 在发布用的提交上
VER=<版本号>
mobile/android/native/proot/build-proot.sh --check     # 确认随包的二进制就是这份源码构建出来的
OUT=forsion-${VER}-proot-source
mkdir -p "$OUT"
# 上游源码原包(与 sources.lock 的 sha256 一致)
while read -r name ver url sha; do
  case "$name" in ''|'#'*) continue ;; esac
  curl -fsSL "$url" -o "$OUT/$name-$ver.tar.gz"
  echo "$sha  $OUT/$name-$ver.tar.gz" | shasum -a 256 -c -
done < mobile/android/native/proot/sources.lock
# 补丁、构建脚本、本说明
cp -R mobile/android/native/proot "$OUT/build"
tar -czf "$OUT.tar.gz" "$OUT"
gh release upload "v${VER}" "$OUT.tar.gz"
```

App 里「设置 › 关于 › 备案与协议 › 开源许可」写明这两个组件的许可，并指向本目录（`PhoneEngineLicenses.tsx`）。

## 没验证的

- 只编了 arm64-v8a；32 位手机与 x86 模拟器上「这台手机」不出现（`LocalEnginePaths.launcherBundled`）。
- 16 KB 页大小的设备：链接参数已按 16 KB 对齐，未在这类设备上跑过。
- 真机未测（11-27 定：不再做真机测试，兜底是先只发测试渠道）。验证在 Android 模拟器（API 35，arm64）上做，台架见 `mobile/scripts/local-engine-emu.cjs`。
