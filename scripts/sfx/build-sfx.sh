#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export SONNISS_DIR=${SONNISS_DIR:-/Users/wawa/Documents/Projects/assets/Sonniss2026}
REQUESTED_DEFAULT=/private/tmp/claude-501/-Users-wawa-Documents-Projects-pascal/pascal-strike/7726d1a1-3332-4024-b7c4-a9e18a74ece4/scratchpad/kenney
EXTRACTED_DEFAULT=/private/tmp/claude-501/-Users-wawa-Documents-Projects-pascal-pascal-strike/7726d1a1-3332-4024-b7c4-a9e18a74ece4/scratchpad/kenney
export KENNEY_DIR=${KENNEY_DIR:-$REQUESTED_DEFAULT}
if [[ ! -d "$KENNEY_DIR" && "$KENNEY_DIR" == "$REQUESTED_DEFAULT" && -d "$EXTRACTED_DEFAULT" ]]; then
  export KENNEY_DIR=$EXTRACTED_DEFAULT
fi
export FFMPEG=${FFMPEG:-/opt/homebrew/bin/ffmpeg}
export FFPROBE=${FFPROBE:-/opt/homebrew/bin/ffprobe}
# OGG_FFMPEG can point to any FFmpeg build with libvorbis (true mono q4).
# Never silently substitute the native stereo-only experimental encoder.
if [[ -z "${OGG_FFMPEG:-}" ]]; then
  if "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep libvorbis >/dev/null; then
    export OGG_FFMPEG=$FFMPEG
  else
    export OGG_FFMPEG='/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/ffmpeg-darwin-arm64'
  fi
fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$ROOT/scripts/sfx/build_sfx.py"
