#!/usr/bin/env bash
# Builds the "This phone" engine npm package in an arm64 Ubuntu 24.04 container (the base's distro and Node), signed.
#
#   mobile/scripts/local-engine/build-android-engine.sh <out-dir> [--key-file <pem>] [--boot-check]
#
# Key: --key-file, else ANDROID_ENGINE_SIGNING_KEY / TANGU_ENGINE_SIGNING_KEY (PEM text), else the maintainer's local
# engine key (~/.forsion-dev/secrets/tangu-engine-signing/key.pem). The key reaches the container as an environment
# variable only. Run `npm run build` in tangu-agent first. Needs Docker that runs linux/arm64 (native on Apple Silicon
# and on GitHub's ubuntu-24.04-arm runners).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${1:?usage: build-android-engine.sh <out-dir> [--key-file <pem>] [--boot-check]}"; shift
KEY_FILE=""; EXTRA=()
while [ $# -gt 0 ]; do case "$1" in --key-file) KEY_FILE="$2"; shift 2 ;; --boot-check) EXTRA+=(--boot-check); shift ;; *) echo "unknown arg $1" >&2; exit 2 ;; esac; done
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
if [ -n "$KEY_FILE" ]; then KEY="$(cat "$KEY_FILE")"
elif [ -n "${ANDROID_ENGINE_SIGNING_KEY:-}" ]; then KEY="$ANDROID_ENGINE_SIGNING_KEY"
elif [ -n "${TANGU_ENGINE_SIGNING_KEY:-}" ]; then KEY="$TANGU_ENGINE_SIGNING_KEY"
elif [ -f "$HOME/.forsion-dev/secrets/tangu-engine-signing/key.pem" ]; then KEY="$(cat "$HOME/.forsion-dev/secrets/tangu-engine-signing/key.pem")"
else echo "no signing key (see the header)" >&2; exit 1; fi
NODE_VER=v24.22.1
NODE_SHA=$(node -p "require('$REPO/desktop/build/runtime-manifest.json').runtimes.node['linux:arm64'].sha256")
[ -f "$REPO/tangu-agent/dist/standalone/main.js" ] || { echo "tangu-agent/dist is missing: run npm run build in tangu-agent first" >&2; exit 1; }
CACHE="${ANDROID_ENGINE_CACHE:-$HOME/.forsion-dev/local-engine/cache}"; mkdir -p "$CACHE"
# tangu-agent goes in without node_modules (the container installs its own from the lock)
SRC="$(mktemp -d)"; trap 'rm -rf "$SRC"' EXIT
for p in dist skills agent-skills package.json package-lock.json LICENSE; do [ -e "$REPO/tangu-agent/$p" ] && cp -R "$REPO/tangu-agent/$p" "$SRC/"; done
[ -e "$SRC/LICENSE" ] || cp "$REPO/LICENSE" "$SRC/LICENSE"
# the key the APK pins (EngineSignature.PRODUCTION_KEY_HEX = tangu-agent/src/boot/signingKey.ts); the bench overrides it
EXPECT="${ANDROID_ENGINE_EXPECT_KEY:-$(node -e "const s=require('fs').readFileSync('$REPO/tangu-agent/src/boot/signingKey.ts','utf8');const b=s.match(/BEGIN PUBLIC KEY-----\\s*([A-Za-z0-9+\\/=]+)/)[1];console.log(Buffer.from(b,'base64').subarray(12).toString('hex'))")}"
SETUP="export DEBIAN_FRONTEND=noninteractive
    T=/cache/node-$NODE_VER-linux-arm64.tar.gz
    if [ ! -f \$T ] || [ \"\${NEED_TOOLS:-}\" = 1 ]; then apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils python3 make g++ >/dev/null; fi
    [ -f \$T ] || curl -fsSL -o \$T https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-arm64.tar.gz
    echo '$NODE_SHA  '\$T | sha256sum -c >/dev/null
    mkdir -p /opt/node && tar -xzf \$T -C /opt/node --strip-components=1
    export PATH=/opt/node/bin:\$PATH"
run() { docker run --rm --platform linux/arm64 "$@"; }
MOUNTS=(-v "$SRC":/src/tangu-agent:ro -v "$REPO/mobile/android/local-engine/lock.json":/src/lock.json:ro -v "$HERE":/src/scripts:ro -v "$OUT":/out -v "$CACHE":/cache)
# 1. stage: npm ci runs dependency install scripts — no key in this container
run -e NEED_TOOLS=1 "${MOUNTS[@]}" ubuntu:24.04 bash -euc "$SETUP
    node /src/scripts/pack-android-engine.mjs --phase stage --tangu /src/tangu-agent --lock /src/lock.json --out /out"
# 2. sign + pack + verify against the pinned key — the key is here, and no package code runs
ANDROID_ENGINE_SIGNING_KEY="$KEY" run -e ANDROID_ENGINE_SIGNING_KEY "${MOUNTS[@]}" ubuntu:24.04 bash -euc "$SETUP
    node /src/scripts/pack-android-engine.mjs --phase sign --lock /src/lock.json --out /out --expect-key $EXPECT" > "$OUT/.stage/summary.json"
# 3. start the engine from the tarball — no key
if [ "${#EXTRA[@]}" -gt 0 ]; then
  run "${MOUNTS[@]}" ubuntu:24.04 bash -euc "$SETUP
    node /src/scripts/pack-android-engine.mjs --phase boot --out /out"
fi
tail -n 1 "$OUT/.stage/summary.json"
