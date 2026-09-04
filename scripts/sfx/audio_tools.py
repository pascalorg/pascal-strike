"""Offline SFX tools: Python standard library plus FFmpeg; no project dependencies."""
import array
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

RATE = 44100
FFMPEG = os.environ.get('FFMPEG', '/opt/homebrew/bin/ffmpeg')
FFPROBE = os.environ.get('FFPROBE', '/opt/homebrew/bin/ffprobe')
OGG_FFMPEG = os.environ.get('OGG_FFMPEG', FFMPEG)


def run(args):
    return subprocess.check_output([str(a) for a in args], stderr=subprocess.PIPE)


def decode(path, filters=None):
    args = [FFMPEG, '-v', 'error', '-i', path]
    if filters:
        args += ['-af', filters]
    raw = run(args + ['-ar', str(RATE), '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', '-'])
    result = array.array('f')
    result.frombytes(raw)
    if sys.byteorder != 'little':
        result.byteswap()
    return result


def db(amplitude):
    return 20 * math.log10(max(amplitude, 1e-12))


def rms(samples):
    return math.sqrt(sum(x*x for x in samples) / max(1, len(samples)))


def peak(samples):
    return max(map(abs, samples), default=0)


def frame_peaks(samples):
    # One millisecond envelopes, retaining the exact sample index of each peak.
    size = round(RATE * .001)
    return [start + max(range(len(samples[start:start+size])),
                        key=lambda j: abs(samples[start+j]))
            for start in range(0, len(samples), size)]


def events(samples, spacing=.04, threshold_db=-12):
    frames = frame_peaks(samples)
    candidates = [i for n, i in enumerate(frames)
                  if db(abs(samples[i])) > threshold_db
                  and (n == 0 or abs(samples[i]) >= abs(samples[frames[n-1]]))
                  and (n == len(frames)-1 or abs(samples[i]) > abs(samples[frames[n+1]]))]
    selected = []
    for i in sorted(candidates, key=lambda i: (-abs(samples[i]), i)):
        if all(abs(i-j) >= spacing*RATE for j in selected):
            selected.append(i)
    return sorted(selected)


def strongest(samples):
    return max(range(len(samples)), key=lambda i: abs(samples[i]))


def bounds(samples, threshold_db=-40, pad=.015):
    # RMS blocks avoid treating a single low-level noise spike as speech onset/end.
    size = round(.005 * RATE)
    threshold = peak(samples) * 10**(threshold_db/20)
    active = [i for i in range(0, len(samples), size)
              if rms(samples[i:i+size]) > threshold]
    if not active:
        raise ValueError('No audible content')
    start = max(0, active[0]/RATE-pad)
    end = min(len(samples)/RATE, (active[-1]+size)/RATE+pad)
    return start, end-start


def cut(source, start, duration, pitch=1, gain_db=0, presence=False):
    return dict(source=source, start=round(start, 6), duration=round(duration, 6),
                pitch=pitch, gain_db=gain_db, presence=presence)


def render(layers, destination, duration, fade=.04):
    args = [FFMPEG, '-v', 'error', '-y']
    filters = []
    for n, layer in enumerate(layers):
        args += ['-i', layer['source']]
        chain = (f'[{n}:a]aresample={RATE},aformat=sample_fmts=flt:channel_layouts=mono,'
                 f"atrim=start={layer['start']}:duration={layer['duration']},asetpts=PTS-STARTPTS,highpass=f=80")
        if layer['pitch'] != 1:
            chain += f",asetrate={round(RATE*layer['pitch'])},aresample={RATE}"
        if layer['presence']:
            chain += ',equalizer=f=4000:t=q:w=1:g=3'
        # Peak-reference each layer before its relative mixing gain.
        temp = destination.with_name(destination.stem + f'-layer{n}.wav')
        run([FFMPEG, '-v', 'error', '-y', '-i', layer['source'], '-af',
             chain.split(']', 1)[1], '-c:a', 'pcm_f32le', temp])
        gain = -1 - db(peak(decode(temp))) + layer['gain_db']
        filters.append(chain + f',volume={gain:.9f}dB[a{n}]')
    inputs = ''.join(f'[a{n}]' for n in range(len(layers)))
    filters.append(inputs + f'amix=inputs={len(layers)}:normalize=0,apad,atrim=duration={duration},'
                   f'afade=t=in:d=0.001,afade=t=out:st={max(0,duration-fade)}:d={fade}[out]')
    run(args + ['-filter_complex', ';'.join(filters), '-map', '[out]',
                '-ar', str(RATE), '-ac', '1', '-c:a', 'pcm_f32le', destination])
    # Final gain-only normalization; no compressor, limiter, or loudness processing.
    gain = -1 - db(peak(decode(destination)))
    normalized = destination.with_name(destination.stem + '-normalized.wav')
    run([FFMPEG, '-v', 'error', '-y', '-i', destination,
         '-af', f'volume={gain:.9f}dB', '-c:a', 'pcm_f32le', normalized])
    normalized.replace(destination)


def encode(master, destination):
    codec = (['-c:a', 'libvorbis', '-q:a', '4'] if destination.suffix == '.ogg'
             else ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
    executable = OGG_FFMPEG if destination.suffix == '.ogg' else FFMPEG
    gain, best, best_gain = 0, float('inf'), 0
    lower, upper = None, None
    # Encode/decode gain correction compensates codec overshoot without limiting.
    for attempt in range(48):
        if attempt >= 24:
            # Vorbis psychoacoustic decisions can jump at quantization boundaries.
            # Search around the best gain if a bracket cannot converge.
            offset = ((attempt-24)//2+1)*.025
            gain = best_gain + (offset if attempt % 2 == 0 else -offset)
        candidate = master.with_name(master.stem + f'-encode{attempt}' + destination.suffix)
        run([executable, '-v', 'error', '-y', '-i', master, '-map_metadata', '-1',
             '-af', f'volume={gain:.9f}dB', '-ar', str(RATE), '-ac', '1', *codec, candidate])
        correction = -1-db(peak(decode(candidate)))
        if abs(correction) < best:
            destination.write_bytes(candidate.read_bytes())
            best = abs(correction)
            best_gain = gain
        if best <= .08:
            break
        if correction > 0:
            lower = gain if lower is None else max(lower, gain)
        else:
            upper = gain if upper is None else min(upper, gain)
        gain = (lower+upper)/2 if lower is not None and upper is not None else gain+correction
    if best > .15:
        raise ValueError(f'{destination.name}: decoded peak misses -1 dBFS by {best:.3f} dB')


def metrics(path):
    # Legacy footsteps duplicate mono into L/R. Measure one channel rather than
    # summing them with FFmpeg's equal-power downmix (which would add 3 dB).
    samples = decode(path, 'pan=mono|c0=c0')
    high = decode(path, 'pan=mono|c0=c0,highpass=f=3000,highpass=f=3000')
    info = json.loads(run([FFPROBE, '-v', 'error', '-show_streams', '-of', 'json', path]))['streams'][0]
    return dict(peak_dbfs=round(db(peak(samples)), 3), rms_dbfs=round(db(rms(samples)), 3),
                high_rms_dbfs=round(db(rms(high)), 3), duration=round(len(samples)/RATE, 6),
                channels=info['channels'], sample_rate=int(info['sample_rate']),
                bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
