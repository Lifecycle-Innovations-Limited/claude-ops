"""Read-only whole-file measurements and an explicitly complete audio packet.

Memory is bounded by the configured measurement window, not file duration.
No network, analysis-model, renderer or delivery-check imports belong here.
"""
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import numpy as np

RATE = 44100


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def number(value, name, *, minimum=None, maximum=None):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f'{name}: verwacht een eindig getal')
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ValueError(f'{name}: buiten bereik')
    return float(value)


def _document(value):
    if value is None:
        return {}
    if isinstance(value, (str, Path)):
        value = json.loads(Path(value).read_text())
    if not isinstance(value, dict):
        raise ValueError('Brief/setlist moet een JSON-object zijn')
    # Copy untrusted metadata; reject non-JSON/nonfinite values without altering it.
    return json.loads(json.dumps(value, allow_nan=False))


def _timestamps(document):
    if 'transitions' in document:
        values = document['transitions']
        if not isinstance(values, list):
            raise ValueError('transitions moet een lijst met seconden zijn')
    else:
        values = None
        for key, field in (('entries', 'start'), ('tracks', 'audible_start'),
                           ('workout_blocks', 'from')):
            if key not in document:
                continue
            rows = document[key]
            if key == 'tracks' and isinstance(rows, str):
                continue  # Native mixbrief source directory, not revision timing.
            if not isinstance(rows, list) or not rows:
                raise ValueError(f'{key}: ontbrekende tijdstempels')
            starts = [number(row.get(field), field, minimum=0) if isinstance(row, dict)
                      else number(None, field) for row in rows]
            if starts[0] != 0 or any(b <= a for a, b in zip(starts, starts[1:])):
                raise ValueError(f'{key}: verwacht eerste start op nul en oplopende tijden')
            values = starts[1:]
            break
    if values is None:
        return None
    result = [number(v, 'transition') for v in values]
    if any(b <= a for a, b in zip(result, result[1:])):
        raise ValueError('Transities moeten uniek en oplopend zijn')
    return result


@contextmanager
def _decode_chunks(audio, frames_per_chunk):
    # File-backed stderr avoids a deadlock or unbounded stderr accumulation.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            ['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-i', str(audio), '-map', '0:a:0',
             '-vn', '-f', 'f32le', '-ac', '2', '-ar', str(RATE), 'pipe:1'],
            stdout=subprocess.PIPE, stderr=errors)
        stream = process.stdout
        if stream is None:
            process.kill()
            process.wait()
            raise ValueError('ffmpeg gaf geen audiostream terug')

        def chunks():
            size = frames_per_chunk * 8
            while True:
                raw = stream.read(size)
                if not raw:
                    break
                if len(raw) % 8:
                    raise ValueError('Onvolledig gedecodeerd audioframe')
                samples = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
                if not np.isfinite(samples).all():
                    raise ValueError('Niet-eindige audiosamples')
                yield samples
            code = process.wait()
            errors.seek(0, os.SEEK_END)
            if code != 0 or errors.tell():
                raise ValueError('ffmpeg kon de volledige audio niet decoderen')
        try:
            yield chunks()
        finally:
            stream.close()
            if process.poll() is None:
                process.kill()
            process.wait()


def _db(amplitude):
    return 20 * math.log10(amplitude) if amplitude > 0 else None


def _measure(audio, thresholds, log):
    count = clipped = 0
    square_sum = peak = 0.0
    silence_run = longest = longest_end = 0
    previous_db = None
    max_jump = None
    windows = 0
    with _decode_chunks(audio, round(RATE * thresholds['window_seconds'])) as chunks:
        for samples in chunks:
            magnitude = np.abs(samples.astype(np.float64))
            n = len(samples)
            window_peak = float(magnitude.max())
            window_square = float(np.square(magnitude).sum())
            window_clip = int(np.count_nonzero(magnitude >= thresholds['clip_level']))
            # Runs are counted in frames with BOTH channels below threshold.
            quiet = magnitude.max(axis=1) <= 10 ** (thresholds['silence_db'] / 20)
            boundaries = np.flatnonzero(np.diff(np.r_[False, quiet, False].astype(np.int8)))
            for start, end in zip(boundaries[::2], boundaries[1::2]):
                run = int(end - start) + (silence_run if start == 0 else 0)
                if run > longest:
                    longest, longest_end = run, count + int(end)
            if quiet[-1]:
                silence_run = n + silence_run if quiet.all() else int(boundaries[-1] - boundaries[-2])
            else:
                silence_run = 0
            rms_db = _db(math.sqrt(window_square / (2 * n)))
            audible_db = rms_db if rms_db is not None and rms_db > thresholds['silence_db'] else None
            jump = None if previous_db is None or audible_db is None else abs(audible_db - previous_db)
            if jump is not None and (max_jump is None or jump > max_jump['db']):
                max_jump = {'at_seconds': count / RATE, 'db': jump}
            window = {'start_seconds': count / RATE, 'end_seconds': (count + n) / RATE,
                      'peak': window_peak, 'rms_dbfs': rms_db, 'clipped_samples': window_clip,
                      'level_change_db': jump}
            if log is not None:
                log.write(json.dumps(window, allow_nan=False) + '\n')
            previous_db = audible_db
            peak = max(peak, window_peak)
            square_sum += window_square
            clipped += window_clip
            count += n
            windows += 1
    if not count:
        raise ValueError('Lege audio')
    return {'coverage': 'whole_file', 'frames': count, 'sample_rate': RATE, 'channels': 2,
            'duration_seconds': count / RATE, 'peak': peak, 'peak_dbfs': _db(peak),
            'rms_dbfs': _db(math.sqrt(square_sum / (count * 2))),
            'clipped_samples': clipped, 'measurement_windows': windows,
            'longest_silence': {'start_seconds': (longest_end - longest) / RATE,
                               'end_seconds': longest_end / RATE, 'duration_seconds': longest / RATE},
            'largest_level_change': max_jump,
            'flags': {'clipping': clipped > 0, 'silence': longest / RATE >= thresholds['silence_seconds'],
                      'level_change': max_jump is not None and max_jump['db'] >= thresholds['level_jump_db']}}


def judge_mix(audio, *, brief=None, setlist=None, output=None, silence_db=-60,
              silence_seconds=1, clip_level=.999, level_jump_db=6, window_seconds=1,
              transition_context_seconds=10, duration_tolerance_seconds=.1):
    """Measure all decoded audio; output is a NEW packet directory, never a file.

    Transitions are seconds in ``transitions``, renderer ``entries[].start``,
    revision ``tracks[].audible_start`` or workout ``workout_blocks[].from``.
    Missing transition metadata remains unknown. All supplied transitions are
    checked. The optional brief is context only, never a delivery authorization.
    """
    audio = Path(audio).resolve()
    if not audio.is_file():
        raise ValueError('Audiobestand ontbreekt')
    thresholds = {
        'silence_db': number(silence_db, 'silence_db', minimum=-200, maximum=0),
        'silence_seconds': number(silence_seconds, 'silence_seconds', minimum=.0001),
        'clip_level': number(clip_level, 'clip_level', minimum=.000001, maximum=1),
        'level_jump_db': number(level_jump_db, 'level_jump_db', minimum=.0001),
        'window_seconds': number(window_seconds, 'window_seconds', minimum=1 / RATE, maximum=60)}
    context = number(transition_context_seconds, 'transition_context_seconds', minimum=1 / RATE)
    tolerance = number(duration_tolerance_seconds, 'duration_tolerance_seconds', minimum=0)
    brief, setlist = _document(brief), _document(setlist)
    brief_times, setlist_times = _timestamps(brief), _timestamps(setlist)
    if brief_times is not None and setlist_times is not None and brief_times != setlist_times:
        raise ValueError('Brief en setlist hebben verschillende transitietijden')
    times = setlist_times if setlist_times is not None else brief_times
    destination = Path(output).absolute() if output is not None else None
    if destination is not None and (destination.exists() or destination.is_symlink()):
        raise FileExistsError('Uitvoermap bestaat al')
    source_hash = file_hash(audio)
    # Staging is private and renamed only after every validation/extraction succeeds.
    if destination:
        destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.mixforge-judge-',
                                     dir=destination.parent if destination else None) as temp:
        staging = Path(temp) / 'packet'
        staging.mkdir()
        with (staging / 'measurements.jsonl').open('w') as log:
            metrics = _measure(audio, thresholds, log)
        duration = metrics['duration_seconds']
        if times is not None and any(not 0 < t < duration for t in times):
            raise ValueError('Transitietijd moet binnen de audio liggen')
        transitions = [{'id': f'transition-{i + 1}', 'at_seconds': t,
                        'start_seconds': max(0, t - context), 'end_seconds': min(duration, t + context)}
                       for i, t in enumerate(times or [])]
        expected = brief.get('duration_seconds', brief.get('seconds'))
        if expected is None and 'minutes' in brief:
            expected = number(brief['minutes'], 'minutes', minimum=.0001) * 60
        if expected is None:
            expected = setlist.get('duration')
        check = {'status': 'unknown'}
        if expected is not None:
            expected = number(expected, 'duration', minimum=.0001)
            check = {'expected_seconds': expected, 'actual_seconds': duration,
                     'difference_seconds': duration - expected,
                     'tolerance_seconds': tolerance, 'matches': abs(duration - expected) <= tolerance}
        items = [{'id': 'full_mix', 'start_seconds': 0, 'end_seconds': duration,
                  'path': str(audio), 'sha256': source_hash}]
        if destination:
            full_name = 'full_mix' + audio.suffix
            shutil.copyfile(audio, staging / full_name)
            items[0]['path'] = str(destination / full_name)
            if file_hash(staging / full_name) != source_hash:
                raise ValueError('Audio gewijzigd tijdens pakketopbouw')
            for transition in transitions:
                name = transition['id'] + '.wav'
                with tempfile.TemporaryFile() as errors:
                    result = subprocess.run(
                        ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(audio), '-ss',
                         str(transition['start_seconds']), '-t',
                         str(transition['end_seconds'] - transition['start_seconds']),
                         '-map', '0:a:0', '-vn', '-ac', '2', '-ar', str(RATE),
                         '-c:a', 'pcm_s24le', str(staging / name)], stderr=errors,
                        stdout=subprocess.DEVNULL, check=False)
                if result.returncode:
                    raise ValueError('ffmpeg kon transitie niet extraheren')
                items.append({key: value for key, value in transition.items() if key != 'at_seconds'} |
                             {'path': str(destination / name), 'sha256': file_hash(staging / name)})
        if file_hash(audio) != source_hash:
            raise ValueError('Bronaudio gewijzigd tijdens beoordeling')
        supplied = {key: brief[key] for key in ('ready_for_delivery', 'ready_for_final_delivery',
                    'unresolved_requirements', 'delivery_blockers', 'remaining', 'apple_delivery') if key in brief}
        report = {'version': 1, 'source': {'path': str(audio), 'sha256': source_hash},
                  'thresholds': thresholds, 'local': metrics, 'duration_check': check,
                  'transitions': {'coverage': 'unknown' if times is None else 'all_supplied',
                                  'items': transitions},
                  'packet': {'status': 'prepared' if destination else 'not_prepared', 'items': items,
                             'measurements': str(destination / 'measurements.jsonl') if destination else None},
                  'context': {'brief': brief, 'setlist': setlist},
                  'musical': {'status': 'unknown', 'reason': 'Geen audio-modelbeoordeling uitgevoerd'},
                  'delivery': {'status': 'not_assessed', 'supplied': supplied},
                  'limitations': ['Sample peak/RMS, geen true peak of LUFS.',
                                  'Geen bewijs van BPM, beat/frase/stereo, rechten of luisteracceptatie.',
                                  'Coverage betreft alle opgegeven transities, geen automatische detectie.']}
        if destination:
            (staging / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
            # mkdir reserves the target without replacing a concurrent writer.
            destination.mkdir()
            placed = []
            try:
                for child in staging.iterdir():
                    target = destination / child.name
                    os.link(child, target)  # Exclusive; never replace a competing file.
                    placed.append((target, child.stat().st_ino))
            except BaseException:
                # Only unlink this invocation's inodes; preserve concurrent replacements.
                for target, inode in placed:
                    if target.exists() and target.lstat().st_ino == inode:
                        target.unlink()
                try:
                    destination.rmdir()
                except OSError:
                    pass  # Concurrent writer's files remain owned by that writer.
                raise
        return report
