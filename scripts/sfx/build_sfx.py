"""Select Sonniss excerpts, build into temporary storage, then publish audited assets."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from audio_tools import (RATE, OGG_FFMPEG, bounds, cut, db, decode, encode, events,
                         metrics, peak, render, rms, run, strongest)
from report_sfx import write_report

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/sfx'
SONNISS = Path(os.environ['SONNISS_DIR']).expanduser().resolve()
KENNEY = Path(os.environ['KENNEY_DIR']).expanduser().resolve()
FRAGMENTS = {
    'marker': 'AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05',
    'whip': 'WEAPWhip_WHIP Snap Crack 05',
    'wall': 'WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03',
    'gore': 'GORESplt_Gore Designed Transient Heavy Impact Smash 01',
    'water': 'WATRMisc_Water, Liquid Impact, Bubble, Sci Fi, Hit 04',
    'tick': 'Interface Percussion Snap',
    'reload-start': 'MACHMech_Mechanism Counting Machine Interact Loose Container Short 01',
    'latch': 'MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02',
    'handling': 'METLTonl_Item Spring Wire Impact Flick Top Clatter Light Tap',
    'swing': 'METLFric_SWING SCRAPE Swift Melee Weapon Swing With A Long Blade 14',
    'thud': 'SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01',
    'ice': 'ICEBrk_Skill Freeze Whoosh Break Impact Layered Movement Shatter 03',
    'shards': 'GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05',
    'door': 'DOORMetl_StairWellDoor01_InMotionAudio_USAHotel',
    'respawn': 'Game Entry Happy Short',
    'deny': 'Deny Muted',
}


def select(paths, samples, work):
    recipes, decisions = {}, {}

    def add(stem, layers, duration, fade=.04, note=''):
        recipes[stem] = dict(layers=layers, duration=duration, fade=fade, note=note)

    def at_peak(key, duration, preroll=.005, **kwargs):
        start = max(0, strongest(samples[key])/RATE-preroll)
        return cut(paths[key], start, min(duration, len(samples[key])/RATE-start), **kwargs)

    marker = samples['marker']
    detected = events(marker)
    isolated = []
    for i in detected:
        # Preceding 120 ms ends at the 5 ms pre-roll boundary, excluding the attack.
        if i < round(.125*RATE) or i+round(.215*RATE) > len(marker):
            continue
        pre = marker[i-round(.125*RATE):i-round(.005*RATE)]
        isolation = db(abs(marker[i]))-db(peak(pre))
        if isolation >= 18 and not any(i < j <= i+.150*RATE for j in detected):
            isolated.append(dict(sample=i, time=i/RATE, isolation_db=isolation,
                                 source_peak_dbfs=db(abs(marker[i]))))
    isolated.sort(key=lambda c: (-c['isolation_db'], c['time']))
    fallback = len(isolated) < 4
    chosen = isolated[:4]
    if fallback:
        chosen = [dict(sample=i, time=i/RATE, source_peak_dbfs=db(abs(marker[i])))
                  for i in sorted(detected, key=lambda i: -abs(marker[i]))[:4]]
    if len(chosen) != 4:
        raise ValueError('Fewer than four marker transients')
    # Brightness is measured as double-3 kHz-highpassed RMS minus full RMS;
    # the 90% energy time breaks brightness ties in favour of shorter transients.
    for n, candidate in enumerate(chosen):
        start = max(0, candidate['time']-.005)
        duration = .220
        if fallback:
            following = [(i/RATE-start) for i in detected if i > candidate['sample']]
            duration = max(.045, min([.140, *following]))
        candidate['cut_duration'] = duration
        temporary = work / f'marker-candidate-{n}.wav'
        render([cut(paths['marker'], start, duration)], temporary, duration, .04 if fallback else .06)
        m = metrics(temporary)
        candidate['brightness_db'] = m['high_rms_dbfs']-m['rms_dbfs']
        data = decode(temporary)
        total = sum(x*x for x in data)
        energy = 0
        for i, x in enumerate(data):
            energy += x*x
            if energy >= .9*total:
                candidate['energy90_seconds'] = i/RATE
                break
    pistol = max(chosen, key=lambda c: (round(c['brightness_db'], 1), -c['energy90_seconds']))
    # The other three retain their isolation ranking; all four selections are distinct.
    for n, candidate in enumerate(c for c in chosen if c is not pistol):
        add(f'shot-{n+1}', [cut(paths['marker'], candidate['time']-.005, candidate['cut_duration'])],
            candidate['cut_duration'], .04 if fallback else .06, 'Isolated marker; no whip layer.')
    add('pistol-shot', [cut(paths['marker'], pistol['time']-.005, .140, presence=True)], .140,
        note='Brightest of the four; +3 dB presence bell at 4 kHz.')
    decisions['marker'] = dict(detected_peaks=len(detected), isolated_count=len(isolated),
                               fallback=fallback, selected=chosen, pistol_time=pistol['time'],
                               whip='Optional whip layer omitted to retain the natural marker transient and character.')

    wall = samples['wall']
    hits = events(wall, .100, db(peak(wall))-6)
    hits = sorted(sorted(hits, key=lambda i: -abs(wall[i]))[:3])
    if len(hits) >= 3:
        for n, i in enumerate(hits):
            start = max(0, i/RATE-.003)
            end = min(len(wall)/RATE, start+.120,
                      hits[n+1]/RATE-.004 if n+1 < len(hits) else len(wall)/RATE)
            add(f'splat-{n+1}', [cut(paths['wall'], start, end-start)], end-start, .025,
                'Separate detected wall-splat hit.')
    else:
        start, duration = bounds(wall)
        duration = min(duration, .280)
        for n, pitch in enumerate([.97, 1, 1.03]):
            add(f'splat-{n+1}', [cut(paths['wall'], start, duration, pitch=pitch)], duration,
                note='Single event; subtle pitch variant.')
    decisions['wall_hit_times'] = [i/RATE for i in hits]

    add('body-hit', [at_peak('gore', .180), at_peak('water', .180, gain_db=-6)], .180)
    add('death', [at_peak('gore', .360), at_peak('water', .360, gain_db=-3)], .360, .060)
    start, duration = bounds(samples['tick'])
    add('hit-confirm', [cut(paths['tick'], start, min(.100, duration))], .100, .020)
    add('reload-start', [at_peak('reload-start', .180, .008)], .180)
    add('reload-end', [at_peak('latch', .160, .005)], .160)

    handling = samples['handling']
    clicks = events(handling, .180, db(peak(handling))-18)
    # Rank by attack/background ratio instead of taking the loudest clattery passage.
    clicks.sort(key=lambda i: -(db(abs(handling[i]))-db(rms(handling[max(0,i-round(.100*RATE)):max(0,i-round(.005*RATE))]))))
    chosen_clicks = []
    for i in clicks:
        if i > .100*RATE and all(abs(i-j) > .250*RATE for j in chosen_clicks):
            chosen_clicks.append(i)
        if len(chosen_clicks) == 2:
            break
    if len(chosen_clicks) != 2:
        raise ValueError('Need two distinct handling clicks')
    for stem, i, duration in zip(['weapon-switch', 'dry-fire'], chosen_clicks, [.110, .080]):
        add(stem, [cut(paths['handling'], i/RATE-.003, duration)], duration, .025)

    add('knife-swing', [at_peak('swing', .200, .070)], .200)
    thuds = events(samples['thud'], .8, db(peak(samples['thud']))-4)
    thud = max(thuds, key=lambda i: abs(samples['thud'][i]))
    add('knife-hit', [cut(paths['thud'], thud/RATE-.005, .220),
                      at_peak('gore', .220, gain_db=-6)], .220, .050)
    decisions['thud_candidates'] = [i/RATE for i in thuds]
    add('glass-1', [at_peak('ice', .450, .010)], .450, .060,
        'Impact peak minus 10 ms; whoosh onset skipped.')
    add('glass-2', [at_peak('shards', .450, .010)], .450, .060)
    shard_start = min(strongest(samples['shards'])/RATE+.180, len(samples['shards'])/RATE-.200)
    add('shard-tinkle', [cut(paths['shards'], max(0, shard_start), .200)], .200, .040,
        '200 ms slice after the main shard transient.')

    door = samples['door']
    opening = strongest(door[:RATE])
    first = door[opening:opening+round(.150*RATE)]
    tail = door[opening+round(.400*RATE):opening+round(.750*RATE)]
    ring_delta = db(rms(tail))-db(rms(first))
    decisions['door'] = dict(opening_peak=opening/RATE, late_tail_delta_db=ring_delta,
                             fallback=ring_delta > -18)
    if ring_delta > -18:
        wood = KENNEY / 'impact-sounds/Audio/impactWood_light_002.ogg'
        if not wood.is_file():
            raise ValueError(f'Missing door fallback source: {wood}')
        add('door-handle', [cut(wood, 0, .300), at_peak('latch', .160, gain_db=-6)], .350,
            note='Long door decay; Kenney wood plus Sonniss latch. Playback attenuated 6 dB.')
    else:
        add('door-handle', [cut(paths['door'], max(0, opening/RATE-.010), .350)], .350,
            note='First door movement; playback attenuated 6 dB.')
    for key, stem, duration in [('respawn', 'respawn-chime', .600), ('deny', 'deny', .220)]:
        start, available = bounds(samples[key])
        add(stem, [cut(paths[key], start, min(duration, available))], duration)
    return recipes, decisions


def main():
    if not SONNISS.is_dir():
        raise ValueError(f'Missing SONNISS_DIR: {SONNISS}')
    if 'libvorbis' not in run([OGG_FFMPEG, '-hide_banner', '-encoders']).decode():
        raise ValueError('Set OGG_FFMPEG to a build with libvorbis; true mono is required')
    files = sorted(SONNISS.rglob('*.wav'))
    paths = {}
    for key, fragment in FRAGMENTS.items():
        matches = [p for p in files if fragment in p.name]
        if len(matches) != 1:
            raise ValueError(f'{fragment}: expected one source, found {len(matches)}')
        paths[key] = matches[0]
    # Preserve the checked-in footstep encodes byte-for-byte, including legacy dual-mono OGG.
    footsteps = [OUT / f'footstep-{n}.{ext}' for n in range(1, 5) for ext in ['ogg', 'm4a']]
    for p in footsteps:
        if not p.is_file():
            raise ValueError(f'Missing preserved footstep: {p}')
    with tempfile.TemporaryDirectory(prefix='pascal-strike-sfx-') as folder:
        work = Path(folder)
        samples = {key: decode(path) for key, path in paths.items()}
        recipes, decisions = select(paths, samples, work)
        print(json.dumps(decisions, indent=2), flush=True)
        records = {}
        for stem, recipe in recipes.items():
            print(f'Building {stem}', flush=True)
            master = work / f'{stem}.wav'
            render(recipe['layers'], master, recipe['duration'], recipe['fade'])
            record = dict(recipe, master=metrics(master), encoded={})
            assert abs(record['master']['peak_dbfs']+1) <= .001
            assert abs(record['master']['duration']-recipe['duration']) <= 1/RATE
            for ext in ['ogg', 'm4a']:
                path = work / f'{stem}.{ext}'
                encode(master, path)
                m = metrics(path)
                assert m['bytes'] <= 150_000 and m['channels'] == 1 and m['sample_rate'] == RATE
                record['encoded'][ext] = m
            records[stem] = record
        for n in range(1, 5):
            material = 'concrete' if n < 3 else 'wood'
            source = KENNEY / f'impact-sounds/Audio/footstep_{material}_{(n-1)%2:03}.ogg'
            records[f'footstep-{n}'] = dict(
                layers=[cut(source, 0, .120 if n < 3 else .210)], preserved=True,
                note='Unchanged legacy encode; 100 Hz highpass and original fade.',
                encoded={ext: metrics(OUT / f'footstep-{n}.{ext}') for ext in ['ogg', 'm4a']})
        assert len(records) <= 34
        write_report(work, records, decisions, SONNISS, KENNEY)
        # Publish only after every encode and report passes validation.
        for stem in recipes:
            for ext in ['ogg', 'm4a']:
                (OUT / f'{stem}.{ext}').write_bytes((work / f'{stem}.{ext}').read_bytes())
        for name in ['CREDITS.md', 'measurements.json']:
            (OUT / name).write_bytes((work / name).read_bytes())
        for obsolete in ['soft-hit', 'mechanical-click']:
            for ext in ['ogg', 'm4a']:
                (OUT / f'{obsolete}.{ext}').unlink(missing_ok=True)
        print(f'Published {len(records)} masters, OGG q4 + AAC M4A; footsteps unchanged.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr.decode(errors='replace')) from error
