"""Generate exact source/cut credits and machine-readable decode measurements."""
import json
from pathlib import Path

SOUND_NAMES = {
    'shot-1': 'shot (1/3)', 'shot-2': 'shot (2/3)', 'shot-3': 'shot (3/3)',
    'pistol-shot': 'pistolShot', 'body-hit': 'hit', 'hit-confirm': 'hitConfirm',
    'reload-start': 'reloadStart', 'reload-end': 'reload / reloadEnd',
    'knife-swing': 'knifeSwing', 'knife-hit': 'knifeHit', 'death': 'death',
    'weapon-switch': 'weaponSwitch', 'dry-fire': 'dryFire', 'glass-1': 'glassBreak (1/2)',
    'glass-2': 'glassBreak (2/2)', 'shard-tinkle': 'shardTinkle', 'respawn-chime': 'respawn',
    'door-handle': 'door', 'deny': 'deny', 'announcer-headshot': 'announcerHeadshot',
    'announcer-ten-left': 'announcerTenLeft',
}


def write_report(directory, records, decisions, sonniss, kenney):
    for stem, record in records.items():
        record['sound'] = SOUND_NAMES.get(stem, stem.replace('splat-', 'splat variant ').replace('footstep-', 'footstep variant '))
        for layer in record['layers']:
            source = layer['source']
            layer['library'] = 'Sonniss GDC 2026' if source.is_relative_to(sonniss) else 'Kenney Impact Sounds'
            layer['source'] = str(source.relative_to(sonniss if source.is_relative_to(sonniss) else kenney))
        # WAV masters are temporary; their hashes/byte counts aren't distributed assets.
        if 'master' in record:
            record['master'].pop('sha256')
            record['master'].pop('bytes')
    payload = dict(schema=1, sample_rate=44100, master_peak_dbfs=-1, decisions=decisions, sounds=records)
    (directory / 'measurements.json').write_text(json.dumps(payload, indent=2)+'\n')
    lines = ['# Pascal Strike sound credits', '',
             'Sonniss excerpts: **Sonniss GDC Game Audio Bundle (2026)** — royalty-free; commercial use and modification allowed. '
             'Copyright remains with the respective recording creators named in the source paths. These recordings are not CC0.', '',
             'License supplied with the bundle: `Sonniss.com-GDC2026-GameAudioBundle2of5/License - GDC Game Audio.pdf`. '
             'The bundle Readme also permits personal/commercial use without attribution. '
             'The license prohibits selling the sounds as standalone recordings and prohibits AI training. '
             'These edited excerpts are incorporated into Pascal Strike.', '',
             'Preserved footsteps (and wood door layer if used): [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds), '
             'version 1.0, 2019-12-19, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).', '',
             'Build: `bash scripts/sfx/build-sfx.sh`. `SONNISS_DIR` defaults to '
             '`/Users/wawa/Documents/Projects/assets/Sonniss2026`; `KENNEY_DIR` retains the previous recipe defaults. '
             'Sources are read in place; temporary PCM and masters are removed on exit. No bundle files are copied into the repository. '
             'Only edited OGG/M4A outputs and their reports are distributed here.', '',
             'Processing: 44.1 kHz mono float PCM, 80 Hz highpass for rumble, 1 ms fade-in; no lowpass, '
             'compression, limiting, or loudness normalization. Masters use gain-only normalization to -1 dBFS. '
             'Layer gains are relative to peak-matched layers before the final master normalization. '
             'OGG uses libvorbis q4; M4A uses mono AAC 128 kbps. Gain-only encode/decode correction targets -1 dBFS '
             '(±0.15 dB codec tolerance). All new encodes are mono. The eight existing footstep files remain byte-identical, '
             'including their dual-mono stereo OGG files and original 100 Hz highpass/fades.', '',
             'Manifest mix: shots 0.9, splats/body/knife/death 0.8, deny 0.6, announcers 0.7. '
             'Announcer gain 0.7 provides −3.10 dB attenuation; door gain is the previous 0.39 multiplied by '
             '−6 dB (0.501187). These attenuations are applied at playback so the file peaks remain normalized. '
             'Footstep gain/variants/pitch jitter are unchanged. Deny and announcer entries are prepared in the manifest; '
             'the existing SoundName API and gameplay triggers are unchanged. Optional entries have no added synth fallback.', '',
             '## Selection evidence', '']
    marker = decisions['marker']
    lines += [f"Marker detection found {marker['detected_peaks']} distinct peaks above −12 dBFS and "
              f"{marker['isolated_count']} candidates passing isolation. "
              'Peaks use 1 ms amplitude envelopes, with 40 ms nonmaximum suppression to treat one ringing '
              'transient as one event. The preceding 120 ms is measured by its maximum amplitude and ends '
              '5 ms before the peak (the cut/attack boundary). It must be ≥18 dB quieter; no second detected '
              'peak may occur in the following 150 ms. Candidates are ranked by that isolation margin.', '',
              ('**Fallback used:** insufficient isolated shots; shortest windows at the loudest peaks, with 40 ms fade-out.'
               if marker['fallback'] else 'No marker fallback needed. Four cleanest candidates were selected; the brightest candidate '
               '(double-highpassed/full RMS ratio; shortest 90% energy time breaks ties) supplies the 140 ms pistol. '
               'The other three retain their isolation order as 220 ms marker shots with 60 ms fade-out.'), '',
              marker['whip'], '',
              '| Candidate peak time | Source peak | Preceding isolation | High/full RMS delta | 90% energy time |',
              '| ---: | ---: | ---: | ---: | ---: |']
    for c in marker['selected']:
        isolation = f"{c['isolation_db']:.2f} dB" if 'isolation_db' in c else 'fallback'
        lines.append(f"| {c['time']:.6f} s | {c['source_peak_dbfs']:.2f} dBFS | {isolation} | "
                     f"{c['brightness_db']:.2f} dB | {c['energy90_seconds']:.6f} s |")
    door = decisions['door']
    lines += ['', f"Wall-splat peak times: {', '.join(f'{v:.6f}' for v in decisions['wall_hit_times'])} s. "
              'Separate hits are used when available; otherwise the recipe makes ±3% pitch variants.', '',
              f"Door first-movement peak: {door['opening_peak']:.6f} s. The RMS of the 400–750 ms late tail is "
              f"{door['late_tail_delta_db']:.2f} dB relative to the first 150 ms after that peak. "
              'A tail above −18 dB triggers the wood/latch fallback. '
              + ('Fallback used.' if door['fallback'] else 'The door cut passes; no fallback used.'), '',
              '## Exact sources and cuts', '',
              'Sonniss paths below are relative to `SONNISS_DIR`; Kenney paths are relative to `KENNEY_DIR`. '
              'Each source cut is `start / duration` in seconds before pitch changes, padding, mixing, and fades. '
              'Footstep cut limits are from the original recipe (shorter sources end naturally).', '',
              '| Sound → output pair | Exact source file; cut start / duration | Processing |',
              '| --- | --- | --- |']
    for stem, record in records.items():
        layers = []
        for layer in record['layers']:
            extra = f"; {layer['gain_db']:+g} dB layer; ×{layer['pitch']:g} pitch"
            layers.append(f"{layer['library']}: `{layer['source']}`; **{layer['start']:.6f} / {layer['duration']:.6f} s**{extra}")
        processing = record.get('note', '')
        if 'fade' in record:
            processing += f" Fade-out {record['fade']*1000:g} ms."
        lines.append(f"| {record['sound']} → `{stem}` | {'<br>'.join(layers)} | {processing} |")
    lines += ['', '## Output measurements', '',
              'Measured after decoding, OGG / M4A order. Legacy dual-mono footsteps are measured per channel, without summing L/R. '
              'High RMS applies `highpass=f=3000` twice **for analysis only**; '
              'delta is high RMS minus full RMS. Duration is decoded sample count / 44100 (AAC padding may extend it). '
              '`measurements.json` also records exact master duration/peak, encoder channels, source selections, and SHA-256 hashes.', '',
              '| Output pair | Peak dBFS | Duration s | Full RMS dBFS | High RMS dBFS (delta dB) | Bytes |',
              '| --- | ---: | ---: | ---: | ---: | ---: |']
    for stem, record in records.items():
        values = [record['encoded'][ext] for ext in ['ogg', 'm4a']]
        def pair(key, digits):
            return ' / '.join(f'{m[key]:.{digits}f}' for m in values)
        high = ' / '.join(f"{m['high_rms_dbfs']:.2f} ({m['high_rms_dbfs']-m['rms_dbfs']:+.2f})" for m in values)
        lines.append(f"| `{stem}` | {pair('peak_dbfs', 2)} | {pair('duration', 6)} | "
                     f"{pair('rms_dbfs', 2)} | {high} | {pair('bytes', 0)} |")
    lines += ['', f"Total: {len(records)} masters / {len(records)*2} encoded files; "
              f"largest file {max(m['bytes'] for r in records.values() for m in r['encoded'].values()):,} bytes. "
              'Limits: 34 masters, 150,000 bytes per file.', '']
    (directory / 'CREDITS.md').write_text('\n'.join(lines))
