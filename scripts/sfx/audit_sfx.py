"""Re-decode shipped files and verify budgets, measurements, and provenance hashes."""
import json
from pathlib import Path
from audio_tools import RATE, metrics

OUT = Path(__file__).resolve().parents[2] / 'public/sfx'
report = json.loads((OUT / 'measurements.json').read_text())
records = report['sounds']
assert len(records) <= 34, 'Too many masters'
expected = {f'{stem}.{ext}' for stem in records for ext in ['ogg', 'm4a']}
actual = {p.name for p in OUT.iterdir() if p.suffix in ['.ogg', '.m4a']}
assert actual == expected, f'Unreferenced or missing encodes: {actual ^ expected}'
print('File\tPeak dBFS\tDecoded seconds\tRMS dBFS\tHigh RMS dBFS\tBytes')
for stem, record in records.items():
    for ext, saved in record['encoded'].items():
        path = OUT / f'{stem}.{ext}'
        measured = metrics(path)
        assert measured['sha256'] == saved['sha256'], f'{path.name}: stale report'
        assert measured['bytes'] <= 150_000, f'{path.name}: too large'
        assert measured['sample_rate'] == RATE, f'{path.name}: wrong sample rate'
        channels = 2 if record.get('preserved') and ext == 'ogg' else 1
        assert measured['channels'] == channels, f'{path.name}: wrong channel count'
        assert abs(measured['peak_dbfs']+1) <= .15, f'{path.name}: peak misses -1 dBFS'
        for key in ['peak_dbfs', 'rms_dbfs', 'high_rms_dbfs', 'duration']:
            assert abs(measured[key]-saved[key]) <= .001, f'{path.name}: stale {key}'
        assert measured['duration'] > 0, f'{path.name}: empty audio'
        print(f"{path.name}\t{measured['peak_dbfs']:.3f}\t{measured['duration']:.6f}\t"
              f"{measured['rms_dbfs']:.3f}\t{measured['high_rms_dbfs']:.3f}\t{measured['bytes']}", flush=True)
print(f'PASS: {len(records)} masters, {len(actual)} encodes; all budgets and measurements verified.')
