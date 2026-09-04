#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export FFMPEG=${FFMPEG:-/opt/homebrew/bin/ffmpeg}
export FFPROBE=${FFPROBE:-/opt/homebrew/bin/ffprobe}
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$ROOT/scripts/sfx/audit_sfx.py"
