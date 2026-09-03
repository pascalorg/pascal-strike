#!/usr/bin/env bash
set -euo pipefail

FFPROBE=/opt/homebrew/bin/ffprobe
FFMPEG=/opt/homebrew/bin/ffmpeg
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

for file in "$ROOT"/public/sfx/*.{ogg,m4a}; do
  [[ -e "$file" ]] || continue
  duration=$($FFPROBE -v error -show_entries format=duration -of default=nw=1:nk=1 "$file")
  peak=$($FFMPEG -hide_banner -nostats -i "$file" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \([^ ]* dB\).*/\1/p')
  size=$(stat -f %z "$file")
  printf '%s\t%.3f s\t%s\t%s bytes\n' "$(basename "$file")" "$duration" "$peak" "$size"
done
