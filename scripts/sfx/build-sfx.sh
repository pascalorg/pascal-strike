#!/usr/bin/env bash
set -euo pipefail

FFMPEG=/opt/homebrew/bin/ffmpeg
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/public/sfx"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pascal-strike-sfx.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT"

encode() {
  local name=$1
  local master="$WORK/$name.wav"
  local normalise='loudnorm=I=-10:TP=-3:LRA=7,alimiter=limit=0.707946'
  local aac_volume='-3dB'
  # AAC's transform overshoots on the three overlapping pure tones in this cue.
  [[ "$name" == 'respawn-chime' ]] && aac_volume='-6.5dB'
  # Homebrew's native Vorbis encoder only accepts stereo. Pan one mono master to
  # identical L/R channels; AAC remains true mono below.
  "$FFMPEG" -hide_banner -loglevel error -y -i "$master" -af "$normalise" \
    -ar 44100 -ac 2 -c:a vorbis -strict -2 -q:a 4 "$OUT/$name.ogg"
  "$FFMPEG" -hide_banner -loglevel error -y -i "$master" -af "$normalise,volume=$aac_volume" \
    -ar 44100 -ac 1 -c:a aac -b:a 96k -movflags +faststart "$OUT/$name.m4a"
}

shot() {
  local name=$1 seed=$2 pop_hz=$3 body_hz=$4 tail_ms=$5
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.8:duration=0.008:sample_rate=44100:seed=$seed" \
    -f lavfi -i "sine=frequency=120:duration=0.040:sample_rate=44100" \
    -f lavfi -i "sine=frequency=60:duration=0.045:sample_rate=44100" \
    -f lavfi -i "anoisesrc=color=pink:amplitude=0.7:duration=0.075:sample_rate=44100:seed=$((seed + 1))" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.28:duration=0.015:sample_rate=44100:seed=$((seed + 2))" \
    -filter_complex "[0:a]bandpass=f=$pop_hz:w=1.1,afade=t=out:st=0:d=0.008,volume=0.95[pop];[1:a]afade=t=out:st=0:d=0.040,volume=0.42[hi];[2:a]afade=t=in:st=0:d=0.012,afade=t=out:st=0.012:d=0.033,volume=0.52[lo];[3:a]bandpass=f=$body_hz:w=1.3,afade=t=out:st=0:d=0.075,volume=0.9[body];[4:a]highpass=f=3500,afade=t=out:st=0:d=0.015,adelay=$tail_ms,volume=0.7[hiss];[pop][hi][lo][body][hiss]amix=inputs=5:normalize=0,atrim=duration=0.125" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

pistol() {
  local name=$1 seed=$2
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.9:duration=0.008:sample_rate=44100:seed=$seed" \
    -f lavfi -i "sine=frequency=150:duration=0.032:sample_rate=44100" \
    -f lavfi -i "sine=frequency=75:duration=0.036:sample_rate=44100" \
    -f lavfi -i "anoisesrc=color=pink:amplitude=0.6:duration=0.045:sample_rate=44100:seed=$((seed + 1))" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.25:duration=0.015:sample_rate=44100:seed=$((seed + 2))" \
    -filter_complex "[0:a]bandpass=f=3900:w=1.2,afade=t=out:st=0:d=0.008,volume=1.0[pop];[1:a]afade=t=out:st=0:d=0.032,volume=0.3[hi];[2:a]afade=t=in:st=0:d=0.009,afade=t=out:st=0.009:d=0.027,volume=0.36[lo];[3:a]bandpass=f=1150:w=1.0,afade=t=out:st=0:d=0.045,volume=0.62[body];[4:a]highpass=f=4800,afade=t=out:st=0:d=0.015,adelay=38,volume=0.66[hiss];[pop][hi][lo][body][hiss]amix=inputs=5:normalize=0,atrim=duration=0.090" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

splat() {
  local name=$1 seed=$2 filter_hz=$3 tone_hz=$4
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=brown:amplitude=0.9:duration=0.190:sample_rate=44100:seed=$seed" \
    -f lavfi -i "anoisesrc=color=pink:amplitude=0.55:duration=0.095:sample_rate=44100:seed=$((seed + 1))" \
    -f lavfi -i "sine=frequency=$tone_hz:duration=0.135:sample_rate=44100" \
    -filter_complex "[0:a]lowpass=f=$filter_hz,afade=t=in:st=0:d=0.004,afade=t=out:st=0.035:d=0.155,volume=1.0[wet];[1:a]bandpass=f=1250:w=1.4,afade=t=out:st=0:d=0.095,volume=0.42[skin];[2:a]afade=t=out:st=0:d=0.135,volume=0.22[body];[wet][skin][body]amix=inputs=3:normalize=0,atrim=duration=0.190" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

footstep() {
  local name=$1 seed=$2 cutoff=$3 tone_hz=$4
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=pink:amplitude=0.72:duration=0.125:sample_rate=44100:seed=$seed" \
    -f lavfi -i "anoisesrc=color=brown:amplitude=0.8:duration=0.065:sample_rate=44100:seed=$((seed + 1))" \
    -f lavfi -i "sine=frequency=$tone_hz:duration=0.080:sample_rate=44100" \
    -filter_complex "[0:a]lowpass=f=$cutoff,afade=t=in:st=0:d=0.006,afade=t=out:st=0.025:d=0.100,volume=0.72[sole];[1:a]bandpass=f=310:w=1.2,afade=t=out:st=0:d=0.065,volume=0.75[step];[2:a]afade=t=out:st=0:d=0.080,volume=0.16[body];[sole][step][body]amix=inputs=3:normalize=0,atrim=duration=0.125" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

glass() {
  local name=$1 seed=$2 base=$3
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.72:duration=0.520:sample_rate=44100:seed=$seed" \
    -f lavfi -i "sine=frequency=$base:duration=0.260:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 733)):duration=0.310:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 1511)):duration=0.240:sample_rate=44100" \
    -f lavfi -i "sine=frequency=$((base + 2387)):duration=0.180:sample_rate=44100" \
    -filter_complex "[0:a]highpass=f=2700,afade=t=out:st=0.055:d=0.465,volume=0.8[crash];[1:a]afade=t=out:st=0:d=0.260,volume=0.16[t1];[2:a]adelay=45,afade=t=out:st=0:d=0.310,volume=0.13[t2];[3:a]adelay=105,afade=t=out:st=0:d=0.240,volume=0.11[t3];[4:a]adelay=180,afade=t=out:st=0:d=0.180,volume=0.09[t4];[crash][t1][t2][t3][t4]amix=inputs=5:normalize=0,atrim=duration=0.520" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

click() {
  local name=$1 seed=$2
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.8:duration=0.012:sample_rate=44100:seed=$seed" \
    -f lavfi -i "sine=frequency=920:duration=0.024:sample_rate=44100" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.65:duration=0.010:sample_rate=44100:seed=$((seed + 1))" \
    -f lavfi -i "sine=frequency=620:duration=0.030:sample_rate=44100" \
    -filter_complex "[0:a]bandpass=f=2400:w=0.8,afade=t=out:st=0:d=0.012[c1];[1:a]afade=t=out:st=0:d=0.024,volume=0.28[t1];[2:a]bandpass=f=1750:w=0.9,afade=t=out:st=0:d=0.010,adelay=62,volume=0.84[c2];[3:a]afade=t=out:st=0:d=0.030,adelay=62,volume=0.24[t2];[c1][t1][c2][t2]amix=inputs=4:normalize=0,atrim=duration=0.105" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

respawn() {
  local name=$1
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=440:duration=0.160:sample_rate=44100" \
    -f lavfi -i "sine=frequency=660:duration=0.180:sample_rate=44100" \
    -f lavfi -i "sine=frequency=880:duration=0.220:sample_rate=44100" \
    -filter_complex "[0:a]afade=t=in:st=0:d=0.008,afade=t=out:st=0.035:d=0.125,volume=0.5[a];[1:a]adelay=105,afade=t=in:st=0:d=0.008,afade=t=out:st=0.035:d=0.145,volume=0.45[b];[2:a]adelay=220,afade=t=in:st=0:d=0.008,afade=t=out:st=0.040:d=0.180,volume=0.4[c];[a][b][c]amix=inputs=3:normalize=0,atrim=duration=0.440" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

door() {
  local name=$1 seed=$2
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "anoisesrc=color=brown:amplitude=0.75:duration=0.360:sample_rate=44100:seed=$seed" \
    -f lavfi -i "anoisesrc=color=white:amplitude=0.7:duration=0.014:sample_rate=44100:seed=$((seed + 1))" \
    -f lavfi -i "sine=frequency=115:duration=0.090:sample_rate=44100" \
    -filter_complex "[0:a]bandpass=f=430:w=1.4,afade=t=in:st=0:d=0.025,afade=t=out:st=0.120:d=0.240,volume=0.86[hinge];[1:a]bandpass=f=1900:w=0.8,afade=t=out:st=0:d=0.014,adelay=275,volume=0.86[latch];[2:a]afade=t=out:st=0:d=0.090,adelay=270,volume=0.28[thud];[hinge][latch][thud]amix=inputs=3:normalize=0,atrim=duration=0.360" \
    -ar 44100 -ac 1 "$WORK/$name.wav"
  encode "$name"
}

shot shot-1 101 2700 610 47
shot shot-2 211 3050 700 50
pistol pistol-shot 307
splat splat-1 401 920 118
splat splat-2 503 1080 132
footstep footstep-1 601 720 82
footstep footstep-2 701 830 91
glass glass-1 809 2480
glass glass-2 907 2690
click mechanical-click 1009
respawn respawn-chime
door door-handle 1103

echo "Generated 12 mono masters in OGG Vorbis q4 and AAC M4A at 44.1 kHz."
