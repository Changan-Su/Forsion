#!/usr/bin/env bash
# Pair study B (rendered to 6.5 s) with each score cue, and export MP3s for the listening page.
#   python3 music/make.py && node render.cjs b --dur 6.5 && bash music/mux.sh
set -euo pipefail
cd "$(dirname "$0")/../out"
FF=${FFMPEG:-ffmpeg}
mkdir -p score
ids=("$@")
[ ${#ids[@]} -eq 0 ] && ids=(1-march 2-magi 3-choral 4-ballad 5-battle)
for id in "${ids[@]}"; do
  "$FF" -y -loglevel error -framerate 30 -i frames-b/%05d.png -i "audio/$id-cue.wav" -c:v libx264 -preset slow -b:v 9M -maxrate 12M -bufsize 18M \
    -pix_fmt yuv420p -c:a aac -b:a 256k -shortest -movflags +faststart "score/B-score-$id.mp4"
  "$FF" -y -loglevel error -i "audio/$id-full.wav" -c:a libmp3lame -b:a 192k "score/B-score-$id-full.mp3"
  "$FF" -y -loglevel error -i "audio/$id-cue.wav" -c:a libmp3lame -b:a 192k "score/B-score-$id-cue.mp3"
done
ls -la score
