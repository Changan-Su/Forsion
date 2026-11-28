#!/usr/bin/env bash
# ⚠️ Since the npm engine (mobile/android/local-engine/README.md) only the BASE layer of this script is used: it becomes the
# file pinned in mobile/android/local-engine/lock.json and ships inside the test-channel APK. The engine layer and
# manifest.json below are no longer read by the app (the engine is build-android-engine.sh → npm).
#
# Builds the "This phone" local engine environment as two layers plus a manifest, in an arm64 Ubuntu container:
#   base-<id>.tar.xz      Ubuntu 24.04 + git/curl/xz + Node 24 (/opt/node). Changes rarely.
#   engine-<ver>.tar.xz   /opt/tangu: this checkout's tangu-agent (npm pack + npm ci --omit=dev). Follows the app.
#   manifest.json         what the app downloads: urls relative to the manifest, sha256, sizes.
#
# Stopgap until the CI pipeline exists: run it locally, then serve the output directory (or put it on Forsion storage)
# and point the app at <dir>/manifest.json. Needs Docker that can run linux/arm64 (native on Apple Silicon).
#
#   mobile/scripts/local-engine/build-env.sh <out-dir> [--engine-only] [--gzip]
#     --engine-only  rebuild just the engine layer and rewrite the manifest (reuses base-*.tar.xz in <out-dir>)
#     --gzip         gzip layers instead of xz (bigger, quicker to build; the app reads both)
#
# Run `npm run build` in tangu-agent first: the engine layer packs its dist/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ENG="$REPO/tangu-agent"
OUT="${1:?usage: build-env.sh <out-dir> [--engine-only] [--gzip]}"; shift
ENGINE_ONLY=0; COMP=xz
for a in "$@"; do case "$a" in --engine-only) ENGINE_ONLY=1 ;; --gzip) COMP=gz ;; *) echo "unknown arg $a" >&2; exit 2 ;; esac; done
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
NODE_VER=v24.22.1
NODE_SHA=$(python3 -c "import json;print(json.load(open('$REPO/desktop/build/runtime-manifest.json'))['runtimes']['node']['linux:arm64']['sha256'])")
ENGINE_VER=$(node -p "require('$ENG/package.json').version")
[ -f "$ENG/dist/standalone/main.js" ] || { echo "tangu-agent/dist is missing: run npm run build in tangu-agent first" >&2; exit 1; }
WORK="$OUT/.work"; rm -rf "$WORK"; mkdir -p "$WORK"
sha256() { shasum -a 256 "$1" | cut -c1-64; }

(cd "$ENG" && npm pack --ignore-scripts --pack-destination "$WORK" >/dev/null)
mv "$WORK"/forsion-tangu-agent-*.tgz "$WORK/pkg.tgz"; cp "$ENG/package-lock.json" "$WORK/"

cat > "$WORK/inside.sh" <<INSIDE
set -eu
export DEBIAN_FRONTEND=noninteractive
if [ "$ENGINE_ONLY" = 0 ]; then
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils git less procps tzdata >/dev/null
  cd /tmp && curl -fsSLO https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-arm64.tar.gz
  echo "$NODE_SHA  node-$NODE_VER-linux-arm64.tar.gz" | sha256sum -c >/dev/null
  mkdir -p /opt/node && tar -xzf node-$NODE_VER-linux-arm64.tar.gz -C /opt/node --strip-components=1 && rm node-*.tar.gz
  # headers and docs are not needed at runtime
  rm -rf /opt/node/include /opt/node/share/doc /opt/node/share/man /opt/node/CHANGELOG.md
  for b in node npm npx corepack; do ln -sf /opt/node/bin/\$b /usr/local/bin/\$b; done
  rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log /tmp/*
  mkdir -p /root/.tangu /root/workspace
fi
export PATH=/opt/node/bin:\$PATH
rm -rf /opt/tangu && mkdir -p /opt/tangu && tar -xzf /out/pkg.tgz -C /opt/tangu --strip-components=1 && cp /out/package-lock.json /opt/tangu/
cd /opt/tangu && npm ci --omit=dev --no-audit --no-fund --ignore-scripts=false > /out/npm-ci.log 2>&1
rm -rf /root/.npm /root/.cache /tmp/*
node -e "const D=require('/opt/tangu/node_modules/better-sqlite3');new D(':memory:').prepare('select 1').get();console.log('sqlite ok')"
# Pack inside the container: a Linux file system keeps case-distinct names, modes and links intact.
COMP_CMD="$( [ "$COMP" = xz ] && echo 'xz -T0 -6 -c' || echo 'gzip -6 -c' )"
if [ "$ENGINE_ONLY" = 0 ]; then
  tar --one-file-system -C / --exclude=./opt/tangu --exclude=./out --exclude=./.dockerenv \
      --exclude=./etc/hostname --exclude=./etc/hosts --exclude=./etc/resolv.conf -cf - . | \$COMP_CMD > /out/base.tar
  echo \$(( \$(du -skx / | cut -f1) - \$(du -sk /opt/tangu | cut -f1) )) > /out/base.kb
fi
tar -C / -cf - ./opt/tangu | \$COMP_CMD > /out/engine.tar
du -sk /opt/tangu | cut -f1 > /out/engine.kb
INSIDE

NAME=forsion-local-engine-build
docker rm -f "$NAME" >/dev/null 2>&1 || true
if [ "$ENGINE_ONLY" = 1 ]; then
  BASE_FILE=$(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['base']['url'])")
  [ -f "$OUT/$BASE_FILE" ] || { echo "--engine-only needs $OUT/$BASE_FILE" >&2; exit 1; }
  # reuse the published base: import it as an image and install the engine on top
  case "$BASE_FILE" in *.xz) xz -dc "$OUT/$BASE_FILE" ;; *) gzip -dc "$OUT/$BASE_FILE" ;; esac | docker import --platform linux/arm64 - forsion-local-engine-base:latest >/dev/null
  IMAGE=forsion-local-engine-base:latest
else
  IMAGE=ubuntu:24.04
fi
docker run --rm --name "$NAME" --platform linux/arm64 -v "$WORK":/out "$IMAGE" bash /out/inside.sh

STAMP=$(date -u +%Y%m%d)
if [ "$ENGINE_ONLY" = 0 ]; then
  BASE_ID="ubuntu24.04-node${NODE_VER#v}-$STAMP"
  BASE_FILE="base-$BASE_ID.tar.$COMP"
  mv "$WORK/base.tar" "$OUT/$BASE_FILE"
  BASE_UNPACKED=$(( $(cat "$WORK/base.kb") * 1024 ))
else
  BASE_ID=$(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['base']['version'])")
  BASE_UNPACKED=$(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['base']['unpackedSize'])")
fi
ENGINE_FILE="engine-$ENGINE_VER.tar.$COMP"
mv "$WORK/engine.tar" "$OUT/$ENGINE_FILE"
ENGINE_UNPACKED=$(( $(cat "$WORK/engine.kb") * 1024 ))

python3 - "$OUT" "$BASE_ID" "$BASE_FILE" "$BASE_UNPACKED" "$ENGINE_VER" "$ENGINE_FILE" "$ENGINE_UNPACKED" <<'PY'
import hashlib, json, os, sys
out, base_id, base_file, base_unpacked, eng_ver, eng_file, eng_unpacked = sys.argv[1:]
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
def layer(version, name, unpacked):
    p = os.path.join(out, name)
    return {"version": version, "url": name, "sha256": sha(p), "size": os.path.getsize(p), "unpackedSize": int(unpacked)}
m = {"schema": 1, "arch": "arm64",
     "base": layer(base_id, base_file, base_unpacked),
     "engine": layer(eng_ver, eng_file, eng_unpacked)}
json.dump(m, open(os.path.join(out, "manifest.json"), "w"), indent=2)
print(json.dumps(m, indent=2))
PY
rm -rf "$WORK"
