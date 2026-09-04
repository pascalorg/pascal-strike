#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export SONNISS_DIR=${SONNISS_DIR:-/Users/wawa/Documents/Projects/assets/Sonniss2026}
export KENNEY_DIR=${KENNEY_DIR:-/private/tmp/claude-501/-Users-wawa-Documents-Projects-pascal-pascal-strike/7726d1a1-3332-4024-b7c4-a9e18a74ece4/scratchpad/kenney}
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
exec python3 - "$ROOT" <<'PY'
"""Listening-note revision; helpers and unchanged encodes remain untouched."""
import copy
import json
import math
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(sys.argv[1])
sys.path.insert(0, str(ROOT / 'scripts/sfx'))
from audio_tools import RATE, FFMPEG, db, decode, encode, events, metrics, peak, rms, run, strongest
from report_sfx import SOUND_NAMES

OUT = ROOT / 'public/sfx'
SONNISS = Path(os.environ['SONNISS_DIR'])
KENNEY = Path(os.environ['KENNEY_DIR'])
old = json.loads((OUT / 'measurements.json').read_text())
records = copy.deepcopy(old['sounds'])
files = sorted(SONNISS.rglob('*.wav'))
paths, samples = {}, {}
fragments = {
    'marker': 'AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05',
    'whip': 'WEAPWhip_WHIP Snap Crack 05',
    'wall': 'WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03',
    'water': 'WATRMisc_Water, Liquid Impact, Bubble, Sci Fi, Hit 04',
    'tick': 'Interface Percussion Snap',
    'click': 'MECHClik_USALightSwitch_On05_InMotionAudio_USAHotel',
    'lock': 'Tinkering Antique Lock',
    'latch': 'MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02',
    'thud': 'SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01',
    'pat': 'FOLYClth_SinglePats04_InMotionAudio_FoleyT-Shirt',
    'cloth': 'FOLYClth_ClothMovement24_InMotionAudio_FoleyT-Shirt',
    'ding': 'Ting Coins',
    'shards': 'GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05',
    'squeak': 'ICEFric_Dry Ice High Metal Squeal Groan Bright Squeak Dissonant Short 13',
    'mouse': 'ICEFric_Dry Ice Squeak Metal Animal Mouse Imitation Short 07',
    'kalimba': 'UIMisc_Kalimba 3 Up_CB Sounddesign_APPlicable Sounds',
}
for key, fragment in fragments.items():
    matches = [p for p in files if fragment in p.name]
    assert len(matches) == 1, (fragment, matches)
    paths[key] = matches[0]
    samples[key] = decode(matches[0])
paths['wood'] = KENNEY / 'impact-sounds/Audio/impactWood_light_002.ogg'
for key, stem in [('push', 'footstep_concrete_000'), ('land-concrete', 'footstep_concrete_001'), ('land-wood', 'footstep_wood_001')]:
    paths[key] = KENNEY / f'impact-sounds/Audio/{stem}.ogg'


def layer(key, start, duration, gain=0, pitch=1, delay=0, filters=''):
    p = paths[key]
    base = SONNISS if p.is_relative_to(SONNISS) else KENNEY
    return dict(source=str(p.relative_to(base)), library='Sonniss GDC 2026' if base == SONNISS else 'Kenney Impact Sounds',
                start=round(start, 6), duration=round(duration, 6), gain_db=gain, pitch=pitch,
                delay=delay, filters=filters)


def synth(f0, f1, duration, gain, decay=4):
    return dict(source=f'Sine {f0}→{f1} Hz; exponential decay exp(-{decay}t/d), 1 ms attack, 3 ms release', library='Synthesized',
                start=0, duration=duration, gain_db=gain, pitch=1, delay=0, filters='', f0=f0, f1=f1, decay=decay)


def peak_start(key, preroll=.005):
    return max(0, strongest(samples[key])/RATE-preroll)


def mix(recipe, destination):
    """Peak-match layers, apply offsets, mix, fade, then gain-only peak normalize."""
    args = [FFMPEG, '-v', 'error', '-y']
    chains = []
    for i, item in enumerate(recipe['layers']):
        temp = destination.with_name(f'{destination.stem}-layer-{i}.wav')
        if item['library'] == 'Synthesized':
            d, f0, f1 = item['duration'], item['f0'], item['f1']
            decay = item['decay']
            expression = f'sin(2*PI*({f0}*t+({f1}-{f0})/(2*{d})*t*t))*exp(-{decay}*t/{d})'
            run([FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', f'aevalsrc={expression}:s={RATE}:d={d}',
                 '-af', f'afade=t=in:d=0.001,afade=t=out:st={d-.003}:d=0.003', '-c:a', 'pcm_f32le', temp])
        else:
            source = (SONNISS if item['library'] == 'Sonniss GDC 2026' else KENNEY) / item['source']
            chain = (f'aresample={RATE},aformat=sample_fmts=flt:channel_layouts=mono,'
                     f"atrim=start={item['start']}:duration={item['duration']},asetpts=PTS-STARTPTS,highpass=f=80")
            # Recreate the accepted splat's master envelope before deriving variants/layers.
            if item.get('splat_base'):
                chain += ',afade=t=in:d=0.001,afade=t=out:st=0.095:d=0.025'
            if item['pitch'] != 1:
                chain += f",asetrate={round(RATE*item['pitch'])},aresample={RATE}"
            if item['filters']:
                chain += ',' + item['filters']
            run([FFMPEG, '-v', 'error', '-y', '-i', source, '-af', chain, '-c:a', 'pcm_f32le', temp])
        gain = -1-db(peak(decode(temp)))+item['gain_db']
        args += ['-i', temp]
        chains.append(f"[{i}:a]volume={gain:.9f}dB,adelay={round(item['delay']*RATE)}S:all=1[a{i}]")
    duration, fade = recipe['duration'], recipe['fade']
    chains.append(''.join(f'[a{i}]' for i in range(len(recipe['layers']))) +
                  f'amix=inputs={len(recipe["layers"])}:normalize=0,apad,atrim=duration={duration},'
                  f'afade=t=in:d=0.001,afade=t=out:st={duration-fade}:d={fade}[out]')
    run(args + ['-filter_complex', ';'.join(chains), '-map', '[out]', '-ar', str(RATE), '-ac', '1', '-c:a', 'pcm_f32le', destination])
    gain = -1-db(peak(decode(destination)))
    normalized = destination.with_name(destination.stem+'-normalized.wav')
    run([FFMPEG, '-v', 'error', '-y', '-i', destination, '-af', f'volume={gain:.9f}dB', '-c:a', 'pcm_f32le', normalized])
    normalized.replace(destination)


recipes, decisions = {}, {}
def add(stem, layers, duration, fade=.04, note=''):
    recipes[stem] = dict(layers=layers, duration=duration, fade=fade, note=note)


def splat(gain=0, pitch=1):
    return dict(layer('wall', .127431, .120, gain, pitch), splat_base=True)

for n, pitch, duration in [(1, 1, .220), (2, .975, .240), (3, 1.025, .200)]:
    add(f'shot-{n}', [layer('marker', 21.692506, .220, pitch=pitch,
        filters='equalizer=f=3000:t=q:w=1:g=1.5'), synth(100, 60, .035, -8)], duration, .060,
        'Accepted v1 cut; +1.5 dB at 3 kHz; 100→60 Hz weight. Tail duration varies ±20 ms.')
add('pistol-shot', [layer('marker', 21.692506, .220, pitch=1.1, filters='equalizer=f=4000:t=q:w=1:g=3'),
    layer('whip', peak_start('whip'), .080, -8), synth(90, 90, .040, -5, decay=2.24)], .170, .040,
    'Accepted marker +10% pitch, +3 dB at 4 kHz; whip transient -8 dB; 90 Hz weight -5 dB.')
click_start = peak_start('click', .003)
add('dry-fire', [layer('click', click_start, .070)], .070, .015)
lock = samples['lock']
lock_events = events(lock, .180, db(peak(lock))-18)
def isolation(i):
    return db(abs(lock[i]))-db(peak(lock[max(0,i-round(.100*RATE)):max(0,i-round(.005*RATE))]))
lock_hit = max((i for i in lock_events if i > .100*RATE), key=isolation)
decisions['lock'] = dict(peak_time=lock_hit/RATE, isolation_db=isolation(lock_hit))
add('weapon-switch', [layer('lock', lock_hit/RATE-.003, .120), layer('latch', .010578, .120, -8)], .120, .025,
    'Lock transient selected by maximum preceding 100 ms isolation; latch -8 dB.')
add('reload-end', [layer('latch', .010578, .160, filters='equalizer=f=2500:t=q:w=1:g=2'),
    layer('click', click_start, .070, delay=.025, filters='equalizer=f=2500:t=q:w=1:g=2')], .160, .040,
    'Latch plus 0 dB light-switch click delayed 25 ms; +2 dB at 2.5 kHz on both layers. reload alias shares this pair.')
add('splat-1', [splat(pitch=.96)], .120, .025, 'Accepted v2 envelope at -4% pitch; old v1 removed.')
add('splat-3', [splat(pitch=1.04), layer('wall', .253984, .078215, -8)], .120, .025,
    'Accepted v2 envelope at +4% pitch; old v3 transient -8 dB.')
add('body-hit', [splat(-4), layer('water', .248333, .160, -3)], .160, .040,
    'Accepted splat v2 -4 dB plus liquid -3 dB; no gore. Playback gain 0.55.')
thud = samples['thud']
knife_energy = rms(thud[round(39.210624*RATE):round(39.510624*RATE)])
thuds = [i for i in events(thud, .8, db(peak(thud))-4) if abs(i/RATE-39.215624) > 1
         and rms(thud[max(0,i-round(.005*RATE)):i+round(.295*RATE)]) < knife_energy]
# Lowest energy among complete, full-strength hits; excludes quiet trailing artifacts.
body = min(thuds, key=lambda i: rms(thud[max(0,i-round(.005*RATE)):i+round(.295*RATE)]))
decisions['body_drop'] = dict(peak_time=body/RATE, rms_300ms_dbfs=db(rms(thud[body-round(.005*RATE):body+round(.295*RATE)])),
                              knife_rms_300ms_dbfs=db(knife_energy))
add('death', [layer('thud', body/RATE-.005, .450), layer('cloth', .150, .300, -6), synth(70, 70, .060, -6)],
    .450, .100, 'Lower-energy separate body thud, cloth -6 dB, 70 Hz whump -6 dB. Playback gain 0.7.')
ding = samples['ding']
ding_hit = events(ding, .080, db(peak(ding))-12)[0]
add('hit-confirm', [layer('tick', 0, .100, filters='afade=t=out:st=0.08:d=0.02'), layer('ding', max(0,ding_hit/RATE-.003), .120, -12,
    filters='highpass=f=2000')], .120, .020, 'Percussion snap plus first coin transient, highpass 2 kHz at -12 dB.')
glass_events = events(samples['shards'], .450, db(peak(samples['shards']))-18)
second = max((i for i in glass_events if abs(i/RATE-1.490998) > .450 and i/RATE+.890 <= len(samples['shards'])/RATE),
             key=lambda i: abs(samples['shards'][i]))
decisions['glass'] = dict(peak_times=[1.490998, second/RATE])
for n, start in [(1,1.480998), (2,second/RATE-.010)]:
    add(f'glass-{n}', [layer('shards', start, .900)], .900, .400,
        'Glass shards crash; extended natural tail. ICEBrk source removed.')
add('shard-tinkle', [layer('shards', 1.670998, .400)], .400, .200)
# Reject the primary squeal if the active region is too long after -20% pitch.
sq = samples['squeak']
active = [i for i in range(0,len(sq),441) if rms(sq[i:i+441]) > peak(sq)*10**(-24/20)]
active_duration = (active[-1]-active[0]+441)/RATE/.8
squeak_key = 'mouse' if active_duration > .650 else 'squeak'
squeak_samples = samples[squeak_key]
squeak_hit = next(i for i in events(squeak_samples, .450, db(peak(squeak_samples))-18)
                  if max(0,i/RATE-.020)+.256 <= len(squeak_samples)/RATE)
squeak_start = max(0, squeak_hit/RATE-.020)
decisions['hinge'] = dict(primary_active_seconds_pitched=active_duration, selected=squeak_key,
                          reason=('Primary active region exceeds 650 ms at -20% pitch; use shorter mouse squeak.'
                                  if squeak_key == 'mouse' else 'Primary squeak fits the short active-region limit.'))
add('door-handle', [layer(squeak_key, squeak_start, .256, -10, .8, filters='afade=t=out:st=0.24:d=0.08'),
    layer('wood', 0, .300, delay=.040), layer('latch', .010578, .160, -6, delay=.040)], .420, .040,
    'Hinge -20% pitch, 320 ms after pitch at -10 dB; wood/latch start 40 ms later. Prior door playback gain retained.')
add('respawn-chime', [layer('kalimba', 0, .650)], .650, .250,
    'Real three-note kalimba; source ends naturally at 553 ms, padded to 650 ms. Playback gain 0.3.')

pat_start = peak_start('pat')
add('jump', [layer('pat', pat_start, .120), layer('push', 0, .150, -6)], .150, .030,
    'Cloth pat 0 dB with soft concrete push-off -6 dB. Playback gain 0.25.')
for n, key in [(1, 'land-concrete'), (2, 'land-wood')]:
    add(f'land-{n}', [layer(key, 0, .220), synth(70, 70, .050, -4), layer('pat', pat_start, .120, -8)],
        .220, .040, 'Footstep 0 dB, 50 ms 70 Hz thump -4 dB, cloth pat -8 dB. Playback gain 0.4; fall-speed multiplier 0.6–1.2.')

with tempfile.TemporaryDirectory(prefix='pascal-strike-fine-tune-') as folder:
    work = Path(folder)
    built = []
    for stem, recipe in recipes.items():
        if all(records.get(stem, {}).get(key) == value for key, value in recipe.items()):
            continue
        built.append(stem)
        print(f'Building {stem}', flush=True)
        master = work / f'{stem}.wav'
        mix(recipe, master)
        record = dict(recipe, sound=SOUND_NAMES.get(stem, stem.replace('splat-', 'splat variant ')),
                      master=metrics(master), encoded={})
        assert abs(record['master']['peak_dbfs']+1) <= .001
        assert abs(record['master']['duration']-recipe['duration']) <= 1/RATE
        record['master'].pop('sha256'); record['master'].pop('bytes')
        for ext in ['ogg', 'm4a']:
            dest = work / f'{stem}.{ext}'
            if stem == 'pistol-shot' and ext == 'm4a':
                # Calibrated gain-only AAC trim: retain the peak tolerance and the
                # 1–2 dB full-RMS margin over every decoded marker variant.
                run([FFMPEG, '-v', 'error', '-y', '-i', master, '-map_metadata', '-1',
                     '-af', 'volume=0.015dB', '-ar', str(RATE), '-ac', '1',
                     '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dest])
                record['aac_encode_gain_db'] = .015
            else:
                encode(master, dest)
            m = metrics(dest)
            assert m['bytes'] <= 150_000 and m['channels'] == 1 and m['sample_rate'] == RATE
            assert abs(m['peak_dbfs']+1) <= .15
            record['encoded'][ext] = m
        records[stem] = record
        print(stem, json.dumps(record['master']), flush=True)
    decisions['pistol_full_rms_above_marker_db'] = {
        kind: round(records['pistol-shot'][kind]['rms_dbfs']-records['shot-1'][kind]['rms_dbfs'],3)
        for kind in ['master']}
    for ext in ['ogg','m4a']:
        decisions['pistol_full_rms_above_marker_db'][ext] = round(
            records['pistol-shot']['encoded'][ext]['rms_dbfs']-records['shot-1']['encoded'][ext]['rms_dbfs'],3)
    decisions['pistol_vs_all_markers_db'] = {
        ext: [round(records['pistol-shot']['encoded'][ext]['rms_dbfs']
                    - records[f'shot-{n}']['encoded'][ext]['rms_dbfs'], 3) for n in [1, 2, 3]]
        for ext in ['ogg', 'm4a']}
    assert all(1 <= d <= 2 for ds in decisions['pistol_vs_all_markers_db'].values() for d in ds)
    print(json.dumps(decisions, indent=2), flush=True)
    assert all(1 <= delta <= 2 for delta in decisions['pistol_full_rms_above_marker_db'].values()), 'Pistol must exceed marker full RMS by 1–2 dB'
    # Validate every preserved encode against the report before publishing anything.
    for stem, record in records.items():
        if stem not in built:
            for ext in ['ogg','m4a']:
                assert metrics(OUT/f'{stem}.{ext}') == record['encoded'][ext], stem
    payload = dict(schema=1, sample_rate=RATE, master_peak_dbfs=-1, decisions=decisions, sounds=records)
    (work/'measurements.json').write_text(json.dumps(payload, indent=2)+'\n')
    lines = (OUT/'CREDITS.md').read_text().split('Build:')[0].rstrip().splitlines()
    lines += ['', 'Build: `bash scripts/sfx/build-sfx.sh`. Sources are read in place from `SONNISS_DIR` and `KENNEY_DIR`; temporary masters are removed on exit. '
              'Only changed pairs are rebuilt. reloadStart, knifeSwing, knifeHit, footsteps, deny, and splat v2 remain byte-identical.', '',
              'Processing: mono 44.1 kHz; source layers highpassed at 80 Hz (synthesized low thumps bypass this); no lowpass, compression, limiting, or loudness normalization. '
              'Layers are peak-matched to -1 dBFS before relative gain and delay. Gain-only master normalization: -1 dBFS; 1 ms attack. '
              'OGG libvorbis q4 and mono AAC M4A 128 kbps; decoded peak correction tolerance ±0.15 dB. Legacy footsteps retain their original encodes.', '',
              'Manifest: hit 0.55, death 0.7, respawn 0.3, jump 0.25, land 0.4; other gains unchanged. Deny plays on team refusal. '
              'Jump plays on accepted local jump input; land plays on local ground contact or remote descent stopping above 2.5 m/s, scaled 0.6–1.2 over 2.5–8 m/s. Remote land is culled at 22 m.', '',
              '## Selection evidence', '', '```json', json.dumps(decisions, indent=2), '```', '',
              '## Exact sources and cuts', '',
              'Sonniss paths are relative to `SONNISS_DIR`; Kenney paths are relative to `KENNEY_DIR`. Cuts are start / duration before pitch, padding, and fades. '
              'Synth layers use a linear frequency sweep (or fixed frequency) and exponential amplitude decay. Accepted splat v2 envelopes are applied before pitch/mixing.', '',
              '| Sound → output pair | Exact source; cut start / duration | Processing |', '| --- | --- | --- |']
    for stem, record in records.items():
        sources=[]
        for item in record['layers']:
            detail = f"{item['library']}: `{item['source']}`; **{item['start']:.6f} / {item['duration']:.6f} s**; {item['gain_db']:+g} dB; ×{item['pitch']:g} pitch"
            if item.get('delay'): detail += f"; delay {item['delay']*1000:g} ms"
            if item.get('filters'): detail += f"; `{item['filters']}`"
            sources.append(detail)
        note = record.get('note','')
        if 'aac_encode_gain_db' in record: note += f" AAC gain-only encode trim {record['aac_encode_gain_db']:+g} dB."
        if 'fade' in record: note += f" Fade-out {record['fade']*1000:g} ms."
        if 'duration' in record: note += f" Master {record['duration']*1000:g} ms."
        lines.append(f"| {record['sound']} → `{stem}` | {'<br>'.join(sources)} | {note} |")
    lines += ['', '## Output measurements', '',
              'Decoded OGG / M4A, dBFS. High RMS uses `highpass=f=3000` twice for analysis only; delta = high − full. '
              'Duration is decoded sample count / 44100, including codec padding. Masters have exact requested durations; legacy footsteps are measured per channel. '
              '`measurements.json` includes master metrics and output hashes.', '',
              '| Pair | Peak | Duration s | Full RMS | 3 kHz-highpassed RMS (delta) | Bytes |', '| --- | ---: | ---: | ---: | ---: | ---: |']
    for stem, record in records.items():
        ms=[record['encoded'][ext] for ext in ['ogg','m4a']]
        def pair(key,digits): return ' / '.join(f'{m[key]:.{digits}f}' for m in ms)
        high=' / '.join(f"{m['high_rms_dbfs']:.2f} ({m['high_rms_dbfs']-m['rms_dbfs']:+.2f})" for m in ms)
        lines.append(f"| `{stem}` | {pair('peak_dbfs',2)} | {pair('duration',6)} | {pair('rms_dbfs',2)} | {high} | {pair('bytes',0)} |")
    lines += ['', f"Total: {len(records)} pairs; largest file {max(m['bytes'] for r in records.values() for m in r['encoded'].values()):,} bytes. Limit: 150,000 bytes per file.", '']
    (work/'CREDITS.md').write_text('\n'.join(lines))
    for stem in built:
        for ext in ['ogg','m4a']:
            (OUT/f'{stem}.{ext}').write_bytes((work/f'{stem}.{ext}').read_bytes())
    for name in ['measurements.json','CREDITS.md']:
        (OUT/name).write_bytes((work/name).read_bytes())
    print(f'Published {len(built)} changed pairs; all other audio byte-identical.', flush=True)
PY
