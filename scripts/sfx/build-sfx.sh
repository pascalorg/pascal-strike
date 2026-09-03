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

encode() {
  local name=$1
  local master="$WORK/$name.wav"
  local normalise='loudnorm=I=-12:TP=-3:LRA=7,alimiter=limit=0.707946'
  local aac_volume='-3dB'
  [[ "$name" == splat-* ]] && aac_volume='-4dB'
  [[ "$name" == 'soft-hit' ]] && aac_volume='-5.2dB'
  # Homebrew's native Vorbis encoder only accepts stereo. The two channels carry
  # the same normalized mono master; AAC remains true mono.
  "$FFMPEG" -hide_banner -loglevel error -y -i "$master" -af "$normalise" \
    -ar 44100 -ac 2 -c:a vorbis -strict -2 -q:a 4 "$OUT/$name.ogg"
  "$FFMPEG" -hide_banner -loglevel error -y -i "$master" -af "$normalise,volume=$aac_volume" \
    -ar 44100 -ac 1 -c:a aac -b:a 96k -movflags +faststart "$OUT/$name.m4a"
}

shot() {
  local name=$1 transient=$2 seed=$3 pop_hz=$4 body_gain=$5
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$transient")" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.8:duration=0.008:sample_rate=44100:seed=$seed" \
    -f lavfi -i "sine=frequency=120:duration=0.040:sample_rate=44100" \
    -f lavfi -i "sine=frequency=60:duration=0.045:sample_rate=44100" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.25:duration=0.015:sample_rate=44100:seed=$((seed + 1))" \
    -filter_complex "[0:a]atrim=duration=0.180,highpass=f=100,lowpass=f=4200,afade=t=out:st=0.075:d=0.105,volume=$body_gain[impact];[1:a]bandpass=f=$pop_hz:w=1.1,afade=t=out:st=0:d=0.008,volume=0.8[pop];[2:a]afade=t=out:st=0:d=0.040,volume=0.24[hi];[3:a]afade=t=in:st=0:d=0.010,afade=t=out:st=0.010:d=0.035,volume=0.33[lo];[4:a]highpass=f=3600,afade=t=out:st=0:d=0.015,adelay=62,volume=0.5[hiss];[impact][pop][hi][lo][hiss]amix=inputs=5:normalize=0,atrim=duration=0.180" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

pistol() {
  local name=$1 transient=$2 seed=$3
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$transient")" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.85:duration=0.008:sample_rate=44100:seed=$seed" \
    -f lavfi -i "sine=frequency=145:duration=0.030:sample_rate=44100" \
    -f lavfi -i "sine=frequency=72:duration=0.034:sample_rate=44100" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.22:duration=0.015:sample_rate=44100:seed=$((seed + 1))" \
    -filter_complex "[0:a]atrim=duration=0.125,highpass=f=650,lowpass=f=6500,afade=t=out:st=0.045:d=0.080,volume=0.62[plate];[1:a]bandpass=f=4100:w=1.1,afade=t=out:st=0:d=0.008,volume=0.9[pop];[2:a]afade=t=out:st=0:d=0.030,volume=0.16[hi];[3:a]afade=t=in:st=0:d=0.008,afade=t=out:st=0.008:d=0.026,volume=0.2[lo];[4:a]highpass=f=5000,afade=t=out:st=0:d=0.015,adelay=38,volume=0.48[hiss];[plate][pop][hi][lo][hiss]amix=inputs=5:normalize=0,atrim=duration=0.125" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

splat() {
  local name=$1 soft=$2 punch=$3 cutoff=$4 delay=$5
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$soft")" -i "$(source_file "$IMPACT/$punch")" \
    -f lavfi -i "anoisesrc=color=brown:amplitude=0.22:duration=0.230:sample_rate=44100:seed=$((1200 + delay))" \
    -filter_complex "[0:a]atrim=duration=0.280,lowpass=f=$cutoff,afade=t=out:st=0.090:d=0.190,volume=0.9[soft];[1:a]atrim=duration=0.220,lowpass=f=1500,adelay=$delay,afade=t=out:st=0.055:d=0.165,volume=0.55[punch];[2:a]lowpass=f=720,afade=t=in:st=0:d=0.006,afade=t=out:st=0.045:d=0.185,volume=0.36[wet];[soft][punch][wet]amix=inputs=3:normalize=0,atrim=duration=0.280" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

single_source() {
  local name=$1 source=$2 filters=$3 duration=$4
  "$FFMPEG" -hide_banner -loglevel error -y -i "$(source_file "$source")" \
    -af "$filters,atrim=duration=$duration" -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

reload_end() {
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/impactMetal_medium_001.ogg")" \
    -i "$(source_file "$INTERFACE/click_003.ogg")" \
    -filter_complex "[0:a]atrim=duration=0.180,highpass=f=180,lowpass=f=5200,afade=t=out:st=0.050:d=0.130,volume=0.9[seat];[1:a]highpass=f=1200,adelay=76,volume=0.7[click];[seat][click]amix=inputs=2:normalize=0,atrim=duration=0.180" \
    -ar 44100 -ac 1 "$WORK/reload-end.wav"
  encode reload-end
}

door() {
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/impactWood_light_002.ogg")" \
    -f lavfi -i 'anoisesrc=color=brown:amplitude=0.5:duration=0.360:sample_rate=44100:seed=1701' \
    -filter_complex "[0:a]atrim=duration=0.300,highpass=f=100,lowpass=f=3600,adelay=80,afade=t=out:st=0.090:d=0.210,volume=0.8[wood];[1:a]bandpass=f=430:w=1.4,afade=t=in:st=0:d=0.025,afade=t=out:st=0.100:d=0.260,volume=0.55[hinge];[wood][hinge]amix=inputs=2:normalize=0,atrim=duration=0.380" \
    -ar 44100 -ac 1 "$WORK/door-handle.wav"
  encode door-handle
}

interface_click() {
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$INTERFACE/click_002.ogg")" \
    -i "$(source_file "$INTERFACE/switch_004.ogg")" \
    -filter_complex "[0:a]highpass=f=900,volume=0.85[click];[1:a]atrim=duration=0.105,highpass=f=450,lowpass=f=5200,afade=t=out:st=0.030:d=0.075,volume=0.58[switch];[click][switch]amix=inputs=2:normalize=0,atrim=duration=0.105" \
    -ar 44100 -ac 1 "$WORK/mechanical-click.wav"
  encode mechanical-click
}

glass() {
  local name=$1 source=$2 base=$3
  "$FFMPEG" -hide_banner -loglevel error -y \
    -i "$(source_file "$IMPACT/$source")" \
    -f lavfi -i "sine=frequency=$base:duration=0.250:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 811)):duration=0.280:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 1703)):duration=0.220:sample_rate=44100" \
    -filter_complex "[0:a]atrim=duration=0.300,highpass=f=900,afade=t=out:st=0.060:d=0.240,volume=0.92[break];[1:a]adelay=95,afade=t=out:st=0:d=0.250,volume=0.10[t1];[2:a]adelay=155,afade=t=out:st=0:d=0.280,volume=0.085[t2];[3:a]adelay=245,afade=t=out:st=0:d=0.220,volume=0.07[t3];[break][t1][t2][t3]amix=inputs=4:normalize=0,atrim=duration=0.500" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

shot shot-1 impactPunch_heavy_000.ogg 101 2750 0.72
shot shot-2 impactPunch_heavy_002.ogg 211 3150 0.76
pistol pistol-shot impactPlate_light_001.ogg 307

splat splat-1 impactSoft_heavy_000.ogg impactPunch_medium_000.ogg 1150 7
splat splat-2 impactSoft_heavy_001.ogg impactPunch_medium_002.ogg 1280 11
splat splat-3 impactSoft_heavy_003.ogg impactPunch_medium_004.ogg 1050 16

single_source soft-hit "$IMPACT/impactSoft_medium_001.ogg" 'highpass=f=170,lowpass=f=2800,afade=t=out:st=0.045:d=0.105' 0.150
single_source reload-start "$IMPACT/impactMetal_light_002.ogg" 'highpass=f=500,lowpass=f=6000,afade=t=out:st=0.045:d=0.115' 0.160
reload_end
door

single_source footstep-1 "$IMPACT/footstep_concrete_000.ogg" 'highpass=f=80,lowpass=f=2400,afade=t=out:st=0.030:d=0.090' 0.120
single_source footstep-2 "$IMPACT/footstep_concrete_001.ogg" 'highpass=f=80,lowpass=f=2400,afade=t=out:st=0.030:d=0.090' 0.120
single_source footstep-3 "$IMPACT/footstep_wood_000.ogg" 'highpass=f=80,lowpass=f=2200,afade=t=out:st=0.060:d=0.150' 0.210
single_source footstep-4 "$IMPACT/footstep_wood_001.ogg" 'highpass=f=80,lowpass=f=2200,afade=t=out:st=0.060:d=0.150' 0.210

single_source knife-swing "$SCIFI/laserSmall_004.ogg" 'areverse,highpass=f=350,lowpass=f=6500,afade=t=in:st=0:d=0.015,afade=t=out:st=0.135:d=0.085' 0.220
interface_click
glass glass-1 impactGlass_heavy_000.ogg 2700
glass glass-2 impactGlass_heavy_003.ogg 2950
single_source shard-tinkle "$IMPACT/impactGlass_light_001.ogg" 'highpass=f=1800,afade=t=out:st=0.055:d=0.185' 0.240
single_source respawn-chime "$SCIFI/forceField_002.ogg" 'atrim=start=0.08,highpass=f=500,lowpass=f=6500,afade=t=in:st=0:d=0.018,afade=t=out:st=0.300:d=0.250' 0.550

echo "Generated 20 Kenney-backed masters in OGG Vorbis q4 and AAC M4A at 44.1 kHz."
