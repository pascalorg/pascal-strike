#!/usr/bin/env bash
set -euo pipefail

FFMPEG=/opt/homebrew/bin/ffmpeg
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/public/sfx"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pascal-strike-sfx.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

REQUESTED_DEFAULT=/private/tmp/claude-501/-Users-wawa-Documents-Projects-pascal/pascal-strike/7726d1a1-3332-4024-b7c4-a9e18a74ece4/scratchpad/kenney
EXTRACTED_DEFAULT=/private/tmp/claude-501/-Users-wawa-Documents-Projects-pascal-pascal-strike/7726d1a1-3332-4024-b7c4-a9e18a74ece4/scratchpad/kenney
KENNEY_DIR=${KENNEY_DIR:-$REQUESTED_DEFAULT}
if [[ ! -d "$KENNEY_DIR" && "$KENNEY_DIR" == "$REQUESTED_DEFAULT" && -d "$EXTRACTED_DEFAULT" ]]; then
  KENNEY_DIR=$EXTRACTED_DEFAULT
fi
if [[ ! -d "$KENNEY_DIR" ]]; then
  echo "Kenney pack directory not found: $KENNEY_DIR" >&2
  echo "Set KENNEY_DIR to the directory containing impact-sounds, interface-sounds and sci-fi-sounds." >&2
  exit 1
fi

IMPACT="$KENNEY_DIR/impact-sounds/Audio"
INTERFACE="$KENNEY_DIR/interface-sounds/Audio"
SCIFI="$KENNEY_DIR/sci-fi-sounds/Audio"
mkdir -p "$OUT"

source_file() {
  local path=$1
  [[ -f "$path" ]] || { echo "Missing Kenney source: $path" >&2; exit 1; }
  printf '%s' "$path"
}

peak_level() {
  "$FFMPEG" -hide_banner -nostats -i "$1" \
    -af 'astats=metadata=1:reset=0' -f null - 2>&1 | \
    awk -F': ' '/Peak level dB/ { peak=$2 } END { print peak }'
}

encode() {
  local name=$1
  local master="$WORK/$name.wav"
  local peak_db normalise_db decoded_peak correction attempt candidate error best_error
  peak_db=$(peak_level "$master")
  [[ -n "$peak_db" && "$peak_db" != "-inf" ]] || {
    echo "Could not measure peak for $master" >&2
    exit 1
  }
  normalise_db=$(awk -v peak="$peak_db" 'BEGIN { printf "%.6f", -1.0 - peak }')
  # Homebrew's native Vorbis encoder only accepts stereo. The two channels carry
  # the same peak-normalized mono master; AAC remains true mono. Each lossy
  # encode is measured and gain-corrected so codec overshoot still lands at
  # -1 dBFS without compressing or limiting the transient.
  best_error=999
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    candidate="$WORK/$name.$attempt.ogg"
    "$FFMPEG" -hide_banner -loglevel error -y -i "$master" \
      -af "volume=${normalise_db}dB,pan=stereo|c0=c0|c1=c0" \
      -ar 44100 -c:a vorbis -strict -2 -q:a 4 "$candidate"
    decoded_peak=$(peak_level "$candidate")
    correction=$(awk -v peak="$decoded_peak" 'BEGIN { printf "%.6f", -1.0 - peak }')
    error=$(awk -v delta="$correction" 'BEGIN { if (delta < 0) delta=-delta; printf "%.6f", delta }')
    if awk -v error="$error" -v best="$best_error" 'BEGIN { exit !(error < best) }'; then
      cp "$candidate" "$OUT/$name.ogg"
      best_error=$error
    fi
    normalise_db=$(awk -v gain="$normalise_db" -v delta="$correction" 'BEGIN { printf "%.6f", gain + delta }')
    awk -v error="$error" 'BEGIN { exit !(error <= 0.08) }' && break
  done

  normalise_db=$(awk -v peak="$peak_db" 'BEGIN { printf "%.6f", -1.0 - peak }')
  best_error=999
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    candidate="$WORK/$name.$attempt.m4a"
    "$FFMPEG" -hide_banner -loglevel error -y -i "$master" -af "volume=${normalise_db}dB" \
      -ar 44100 -ac 1 -c:a aac -b:a 128k -movflags +faststart "$candidate"
    decoded_peak=$(peak_level "$candidate")
    correction=$(awk -v peak="$decoded_peak" 'BEGIN { printf "%.6f", -1.0 - peak }')
    error=$(awk -v delta="$correction" 'BEGIN { if (delta < 0) delta=-delta; printf "%.6f", delta }')
    if awk -v error="$error" -v best="$best_error" 'BEGIN { exit !(error < best) }'; then
      cp "$candidate" "$OUT/$name.m4a"
      best_error=$error
    fi
    normalise_db=$(awk -v gain="$normalise_db" -v delta="$correction" 'BEGIN { printf "%.6f", gain + delta }')
    awk -v error="$error" 'BEGIN { exit !(error <= 0.08) }' && break
  done
  return 0
}

shot() {
  local name=$1 transient=$2 seed=$3 pop_hz=$4 body_gain=$5
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$transient")" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.8:duration=0.008:sample_rate=44100:seed=$seed" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.60:duration=0.040:sample_rate=44100:seed=$((seed + 1))" \
    -filter_complex "[0:a]atrim=duration=0.180,highpass=f=100,equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0.075:d=0.105,volume=$body_gain[impact];[1:a]bandpass=f=$pop_hz:w=2,afade=t=out:st=0:d=0.008,volume=1.0[pop];[2:a]highpass=f=3000,afade=t=out:st=0:d=0.040,adelay=20,volume=0.7[hiss];[impact][pop][hiss]amix=inputs=3:normalize=0,atrim=duration=0.180" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/$name.wav"
  encode "$name"
}

pistol() {
  local name=$1 transient=$2 seed=$3
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$transient")" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.85:duration=0.008:sample_rate=44100:seed=$seed" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.28:duration=0.032:sample_rate=44100:seed=$((seed + 1))" \
    -filter_complex "[0:a]atrim=duration=0.125,highpass=f=100,equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0.045:d=0.080,volume=0.62[plate];[1:a]bandpass=f=4400:w=2,afade=t=out:st=0:d=0.008,volume=1.1[pop];[2:a]highpass=f=3000,afade=t=out:st=0:d=0.032,adelay=24,volume=0.9[hiss];[plate][pop][hiss]amix=inputs=3:normalize=0,atrim=duration=0.125" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/$name.wav"
  encode "$name"
}

splat() {
  local name=$1 soft=$2 seed=$3 wet_delay=$4
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$soft")" \
    -f lavfi -i "anoisesrc=color=brown:amplitude=0.22:duration=0.230:sample_rate=44100:seed=$seed" \
    -filter_complex "[0:a]atrim=duration=0.280,highpass=f=100,afade=t=out:st=0.090:d=0.190,volume=1.0[impact];[1:a]lowpass=f=2500,afade=t=in:st=0:d=0.002,afade=t=out:st=0.045:d=0.185,adelay=$wet_delay,volume=0.30[wet];[impact][wet]amix=inputs=2:normalize=0,atrim=duration=0.280" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/$name.wav"
  encode "$name"
}

single_source() {
  local name=$1 source=$2 filters=$3 duration=$4
  "$FFMPEG" -hide_banner -loglevel error -y -i "$(source_file "$source")" \
    -af "$filters,atrim=duration=$duration" -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/$name.wav"
  encode "$name"
}

reload_end() {
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/impactMetal_medium_001.ogg")" \
    -i "$(source_file "$INTERFACE/click_003.ogg")" \
    -filter_complex "[0:a]atrim=duration=0.180,highpass=f=100,equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0.050:d=0.130,volume=0.9[seat];[1:a]highpass=f=1200,equalizer=f=3500:t=q:w=1.2:g=3,adelay=76,volume=0.7[click];[seat][click]amix=inputs=2:normalize=0,atrim=duration=0.180" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/reload-end.wav"
  encode reload-end
}

door() {
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/impactWood_light_002.ogg")" \
    -f lavfi -i 'anoisesrc=color=brown:amplitude=0.5:duration=0.360:sample_rate=44100:seed=1701' \
    -filter_complex "[0:a]atrim=duration=0.300,highpass=f=100,adelay=80,afade=t=out:st=0.090:d=0.210,volume=0.8[wood];[1:a]highpass=f=60,lowpass=f=9000,afade=t=in:st=0:d=0.025,afade=t=out:st=0.100:d=0.260,volume=0.32[hinge];[wood][hinge]amix=inputs=2:normalize=0,atrim=duration=0.380" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/door-handle.wav"
  encode door-handle
}

interface_click() {
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$INTERFACE/click_002.ogg")" \
    -i "$(source_file "$INTERFACE/switch_004.ogg")" \
    -filter_complex "[0:a]highpass=f=900,volume=0.85[click];[1:a]atrim=duration=0.105,highpass=f=450,afade=t=out:st=0.030:d=0.075,volume=0.58[switch];[click][switch]amix=inputs=2:normalize=0,atrim=duration=0.105" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/mechanical-click.wav"
  encode mechanical-click
}

glass() {
  local name=$1 source=$2 base=$3 seed=$4
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$source")" \
    -f lavfi -i "sine=frequency=$base:duration=0.250:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 811)):duration=0.280:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 1703)):duration=0.220:sample_rate=44100" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.30:duration=0.065:sample_rate=44100:seed=$seed" \
    -filter_complex "[0:a]atrim=duration=0.300,highpass=f=100,equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0.060:d=0.240,volume=0.92[break];[1:a]adelay=95,afade=t=out:st=0:d=0.250,volume=0.24[t1];[2:a]adelay=155,afade=t=out:st=0:d=0.280,volume=0.22[t2];[3:a]adelay=245,afade=t=out:st=0:d=0.220,volume=0.18[t3];[4:a]equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0:d=0.065,adelay=18,volume=0.72[shards];[break][t1][t2][t3][shards]amix=inputs=5:normalize=0,atrim=duration=0.500" \
    -ar 44100 -ac 1 -c:a pcm_f32le "$WORK/$name.wav"
  encode "$name"
}

shot shot-1 impactPunch_heavy_000.ogg 101 2750 0.72
shot shot-2 impactPunch_heavy_002.ogg 211 3150 0.76
pistol pistol-shot impactPlate_light_001.ogg 307

splat splat-1 impactSoft_heavy_000.ogg 1207 7
splat splat-2 impactSoft_heavy_001.ogg 1211 11
splat splat-3 impactSoft_heavy_003.ogg 1216 16

single_source soft-hit "$IMPACT/impactSoft_medium_001.ogg" 'highpass=f=100,afade=t=out:st=0.045:d=0.105' 0.150
single_source reload-start "$IMPACT/impactMetal_light_002.ogg" 'highpass=f=100,equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0.045:d=0.115' 0.160
reload_end
door

single_source footstep-1 "$IMPACT/footstep_concrete_000.ogg" 'highpass=f=100,afade=t=out:st=0.030:d=0.090' 0.120
single_source footstep-2 "$IMPACT/footstep_concrete_001.ogg" 'highpass=f=100,afade=t=out:st=0.030:d=0.090' 0.120
single_source footstep-3 "$IMPACT/footstep_wood_000.ogg" 'highpass=f=100,afade=t=out:st=0.060:d=0.150' 0.210
single_source footstep-4 "$IMPACT/footstep_wood_001.ogg" 'highpass=f=100,afade=t=out:st=0.060:d=0.150' 0.210

single_source knife-swing "$SCIFI/laserSmall_004.ogg" 'areverse,highpass=f=100,afade=t=in:st=0:d=0.015,afade=t=out:st=0.135:d=0.085' 0.220
interface_click
glass glass-1 impactGlass_heavy_000.ogg 3200 2301
glass glass-2 impactGlass_heavy_003.ogg 3450 2303
single_source shard-tinkle "$IMPACT/impactGlass_light_001.ogg" 'highpass=f=100,equalizer=f=3500:t=q:w=1.2:g=3,afade=t=out:st=0.055:d=0.185' 0.240
single_source respawn-chime "$SCIFI/forceField_002.ogg" 'atrim=start=0.08,highpass=f=100,afade=t=in:st=0:d=0.018,afade=t=out:st=0.300:d=0.250' 0.550

echo "Generated 20 Kenney-backed masters in OGG Vorbis q4 and AAC M4A at 44.1 kHz."
