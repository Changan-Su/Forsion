#!/usr/bin/env bash
# Encode the full film picture once, then pair it with each score.
#   node render.cjs film --workers 4 --frames-only && python3 music/film_scores.py && bash music/mux_film.sh
set -euo pipefail
cd "$(dirname "$0")/../out"
FF=${FFMPEG:-ffmpeg}
mkdir -p film
"$FF" -y -loglevel error -framerate 30 -i frames-film/%05d.png -c:v libx264 -preset slow -b:v 5M -maxrate 7M -bufsize 10M \
  -pix_fmt yuv420p -movflags +faststart film/picture.mp4
for s in battle choral; do
  "$FF" -y -loglevel error -i film/picture.mp4 -i "audio/film-$s.wav" -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart \
    "film/forsion-2.12-episode-2.12-$s.mp4"
  "$FF" -y -loglevel error -i "audio/film-$s.wav" -c:a libmp3lame -b:a 192k "film/film-$s.mp3"
done
ls -la film
