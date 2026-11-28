#!/usr/bin/env bash
# Builds the two PRoot executables that the "This phone" local engine runs (Android arm64):
#   libproot.so         PRoot (GPL-2.0-or-later), talloc (LGPL-3.0-or-later) linked statically
#   libproot_loader.so  PRoot's loader (static, -nostdlib)
# They ship as standalone programs under jniLibs (executed from nativeLibraryDir), never linked into app code.
#
# Adapted from Mika's tools/sandbox/build-native.sh (Apache-2.0, https://github.com/wangzan101/mika):
# same pinned sources, same patches, same NDK and flags, so the output is byte-identical to Mika's prebuilt files
# (sha256 listed in README.md). Mika's own launcher (libmikarun.so) is not built or shipped.
#
# Usage: mobile/android/native/proot/build-proot.sh [--check]
#   --check  rebuild and compare sha256 with the committed files; exit 1 on mismatch (does not overwrite them)
#
# Needs ANDROID_NDK_HOME (or $ANDROID_HOME/ndk/28.2.13676358, or ~/Library/Android/sdk/ndk/28.2.13676358),
# curl, shasum/sha256sum, patch.
set -euo pipefail

NDK_VERSION=28.2.13676358
API=30

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$ANDROID_DIR/app/src/localEngine/jniLibs/arm64-v8a"
WORK="${PROOT_BUILD_DIR:-$ANDROID_DIR/build/proot-native}"

CHECK=0
case "${1:-}" in
	"") ;;
	--check) CHECK=1 ;;
	*) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
NDK="${ANDROID_NDK_HOME:-$SDK/ndk/$NDK_VERSION}"
case "$(uname -s)" in
	Darwin) HOST_TAG=darwin-x86_64 ;;
	Linux) HOST_TAG=linux-x86_64 ;;
	*) echo "unsupported host $(uname -s)" >&2; exit 2 ;;
esac
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
CC="$TOOLCHAIN/aarch64-linux-android$API-clang"
AR="$TOOLCHAIN/llvm-ar"
STRIP="$TOOLCHAIN/llvm-strip"
[ -x "$CC" ] || { echo "NDK clang not found: $CC" >&2; exit 2; }
NDK_REVISION="$(awk -F' *= *' '$1=="Pkg.Revision"{print $2}' "$NDK/source.properties" 2>/dev/null || true)"
if [ "$NDK_REVISION" != "$NDK_VERSION" ]; then
	echo "NDK version mismatch: $NDK has '${NDK_REVISION:-unknown}', need $NDK_VERSION" >&2
	exit 2
fi

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Map build paths away so the output does not depend on where the checkout lives (reproducible).
REPRO_FLAGS=(-ffile-prefix-map="$WORK"=. -ffile-prefix-map="$HERE"=. -Wno-unused-command-line-argument)
COMMON_CFLAGS=(-O2 -fPIE "${REPRO_FLAGS[@]}")
# 16 KB max page size keeps the binaries loadable on 16 KB page devices.
EXE_LDFLAGS=(-pie -Wl,-z,max-page-size=16384 -Wl,-z,noexecstack -Wl,--build-id=none)

rm -rf "$WORK/src" "$WORK/obj" "$WORK/out"
mkdir -p "$WORK/dl" "$WORK/src" "$WORK/obj" "$WORK/out"

# ---- 1. download and verify sources, apply patches ----
while read -r name version url sum; do
	case "$name" in ''|'#'*) continue ;; esac
	case "$url" in https://*) ;; *) echo "only https:// sources allowed: $name $url" >&2; exit 1 ;; esac
	archive="$WORK/dl/$name-$version.tar.gz"
	if [ ! -f "$archive" ] || [ "$(sha256 "$archive")" != "$sum" ]; then
		curl -fsSL --proto '=https' --proto-redir '=https' -o "$archive.tmp" "$url"
		mv "$archive.tmp" "$archive"
	fi
	actual="$(sha256 "$archive")"
	if [ "$actual" != "$sum" ]; then
		echo "SHA-256 mismatch for $name: $actual (expected $sum)" >&2
		rm -f "$archive"
		exit 1
	fi
	mkdir -p "$WORK/src/$name"
	tar -xzf "$archive" -C "$WORK/src/$name" --strip-components=1
	for p in "$HERE/patches/$name"-*.patch; do
		[ -f "$p" ] || continue
		patch -d "$WORK/src/$name" -p1 --forward --quiet < "$p"
	done
done < "$HERE/sources.lock"

TALLOC_SRC="$WORK/src/talloc"
PROOT_SRC="$WORK/src/proot/src"

# ---- 2. talloc: only talloc.c, as a static library ----
mkdir -p "$WORK/obj/talloc"
TALLOC_VERSION="$(awk '$1=="talloc"{print $2}' "$HERE/sources.lock")"
IFS=. read -r TV_MAJOR TV_MINOR TV_RELEASE <<< "$TALLOC_VERSION"
cat > "$WORK/obj/talloc/config.h" <<EOF
/* 手写的最小配置(安卓 bionic, arm64),只覆盖 talloc.c 用到的部分 */
#define TALLOC_BUILD_VERSION_MAJOR $TV_MAJOR
#define TALLOC_BUILD_VERSION_MINOR $TV_MINOR
#define TALLOC_BUILD_VERSION_RELEASE $TV_RELEASE
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDBOOL_H 1
#define HAVE_BOOL 1
#define HAVE_MALLOC_H 1
#define HAVE_UNISTD_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_AUXV_H 1
#define HAVE_DLFCN_H 1
#define HAVE_USLEEP 1
#define HAVE_GETPEEREID 1
#define HAVE_GETAUXVAL 1
#define HAVE_LINUX_TYPES_H 1
#define HAVE_INTPTR_T 1
#define HAVE_UINTPTR_T 1
#define HAVE_PTRDIFF_T 1
#define HAVE_VA_COPY 1
#define HAVE_C99_VSNPRINTF 1
#define HAVE_SNPRINTF 1
#define HAVE_VSNPRINTF 1
#define HAVE_ASPRINTF 1
#define HAVE_VASPRINTF 1
#define HAVE_DPRINTF 1
#define HAVE_VDPRINTF 1
#define HAVE_STRDUP 1
#define HAVE_STRNDUP 1
#define HAVE_STRNLEN 1
#define HAVE_STRLCPY 1
#define HAVE_STRLCAT 1
#define HAVE_MEMMOVE 1
#define HAVE_MEMMEM 1
#define HAVE_STRERROR 1
#define HAVE_ERRNO_DECL 1
#define HAVE_DECL_EWOULDBLOCK 1
#define HAVE_VOLATILE 1
#define HAVE_CONSTRUCTOR_ATTRIBUTE 1
#define HAVE_DESTRUCTOR_ATTRIBUTE 1
#define HAVE___ATTRIBUTE__ 1
#define HAVE_VISIBILITY_ATTR 1
#define HAVE_FUNCTION_ATTRIBUTE_FORMAT 1
#define HAVE_WARN_UNUSED_RESULT 1
#define _PUBLIC_ __attribute__((visibility("default")))
#define _PRIVATE_ __attribute__((visibility("hidden")))
EOF
"$CC" "${COMMON_CFLAGS[@]}" -w -D_GNU_SOURCE -D__STDC_WANT_LIB_EXT1__=1 \
	-I"$WORK/obj/talloc" -I"$TALLOC_SRC" -I"$TALLOC_SRC/lib/replace" \
	-c "$TALLOC_SRC/talloc.c" -o "$WORK/obj/talloc/talloc.o"
rm -f "$WORK/obj/talloc/libtalloc.a"
"$AR" rcsD "$WORK/obj/talloc/libtalloc.a" "$WORK/obj/talloc/talloc.o"

# ---- 3. PRoot loader: static, -nostdlib ----
PO="$WORK/obj/proot"
mkdir -p "$PO/loader"
PROOT_VERSION="$(awk '$1=="proot"{print $2}' "$HERE/sources.lock")"
cat > "$PO/build.h" <<EOF
#ifndef BUILD_H
#define BUILD_H
#undef VERSION
#define VERSION "$PROOT_VERSION"
#define HAVE_PROCESS_VM
#define HAVE_SECCOMP_FILTER
#endif
EOF
PROOT_CPPFLAGS=(-D_FILE_OFFSET_BITS=64 -D_GNU_SOURCE -I"$PO" -I"$PROOT_SRC" -I"$PROOT_SRC/../lib/uthash/include" -I"$TALLOC_SRC")
LOADER_ADDRESS="$("$CC" -E -dM -DNO_LIBC_HEADER "$PROOT_SRC/arch.h" | awk '$2=="LOADER_ADDRESS"{print $3}')"
LOADER_CFLAGS=(-O2 -fPIC -ffreestanding -Wno-inline-asm "${REPRO_FLAGS[@]}")
"$CC" "${PROOT_CPPFLAGS[@]}" "${LOADER_CFLAGS[@]}" -c "$PROOT_SRC/loader/loader.c" -o "$PO/loader/loader.o"
"$CC" "${PROOT_CPPFLAGS[@]}" "${LOADER_CFLAGS[@]}" -c "$PROOT_SRC/loader/assembly.S" -o "$PO/loader/assembly.o"
"$CC" -static -nostdlib -Wl,--build-id=none,-Ttext="$LOADER_ADDRESS",-z,noexecstack,-z,max-page-size=16384 \
	-o "$PO/loader/loader" "$PO/loader/loader.o" "$PO/loader/assembly.o"
"$STRIP" -o "$WORK/out/libproot_loader.so" "$PO/loader/loader"

# Upstream embeds the loader in PRoot and, without PROOT_LOADER, writes it to a temp dir and executes it there;
# Android does not allow executing files from app data. Embed an empty placeholder: PRoot must be given
# PROOT_LOADER pointing at the copy in nativeLibraryDir (LocalEngineProcess always sets it).
cat > "$PO/loader/loader-wrapped.S" <<'EOF'
	.section .rodata
	.global _binary_loader_elf_start
	.global _binary_loader_elf_end
_binary_loader_elf_start:
_binary_loader_elf_end:
	.section .note.GNU-stack,"",%progbits
EOF

# ---- 4. PRoot itself ----
PROOT_SOURCES=(
	cli/cli.c cli/proot.c cli/note.c
	execve/enter.c execve/exit.c execve/shebang.c execve/elf.c execve/ldso.c execve/auxv.c execve/aoxp.c
	path/binding.c path/glue.c path/canon.c path/path.c path/proc.c path/temp.c
	syscall/seccomp.c syscall/syscall.c syscall/chain.c syscall/enter.c syscall/exit.c syscall/sysnum.c
	syscall/socket.c syscall/heap.c syscall/rlimit.c
	tracee/tracee.c tracee/mem.c tracee/reg.c tracee/event.c
	ptrace/ptrace.c ptrace/user.c ptrace/wait.c
	extension/extension.c extension/kompat/kompat.c extension/fake_id0/fake_id0.c
	extension/link2symlink/link2symlink.c extension/portmap/portmap.c extension/portmap/map.c
)
PROOT_OBJECTS=()
for s in "${PROOT_SOURCES[@]}"; do
	o="$PO/${s%.c}.o"
	mkdir -p "$(dirname "$o")"
	"$CC" "${PROOT_CPPFLAGS[@]}" "${COMMON_CFLAGS[@]}" -w -c "$PROOT_SRC/$s" -o "$o"
	PROOT_OBJECTS+=("$o")
done
"$CC" -I"$PO" "${COMMON_CFLAGS[@]}" -c "$PO/loader/loader-wrapped.S" -o "$PO/loader/loader-wrapped.o"
PROOT_OBJECTS+=("$PO/loader/loader-wrapped.o")
"$CC" "${EXE_LDFLAGS[@]}" -o "$PO/proot" "${PROOT_OBJECTS[@]}" "$WORK/obj/talloc/libtalloc.a"
"$STRIP" -o "$WORK/out/libproot.so" "$PO/proot"

# ---- 5. install or compare ----
ARTIFACTS=(libproot.so libproot_loader.so)
if [ "$CHECK" = 1 ]; then
	status=0
	for a in "${ARTIFACTS[@]}"; do
		built="$(sha256 "$WORK/out/$a")"
		committed="$( [ -f "$OUT_DIR/$a" ] && sha256 "$OUT_DIR/$a" || echo missing)"
		if [ "$built" = "$committed" ]; then
			echo "ok        $a $built"
		else
			echo "MISMATCH  $a built=$built committed=$committed" >&2
			status=1
		fi
	done
	exit "$status"
fi

mkdir -p "$OUT_DIR"
for a in "${ARTIFACTS[@]}"; do
	cp "$WORK/out/$a" "$OUT_DIR/$a"
	chmod 0755 "$OUT_DIR/$a"
	echo "$a $(sha256 "$OUT_DIR/$a")"
done
