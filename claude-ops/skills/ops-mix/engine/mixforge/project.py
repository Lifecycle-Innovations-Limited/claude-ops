"""Hervatbare mixbrief met harde planningsvoorwaarden en controles vooraf."""
import json
import math
from pathlib import Path
import shutil
import os
import numpy as np
from .models import Entry, Plan, Profile, positive
from .camelot import move
from .setlist import scan_tracks
from .reference import profile_from_references
from .render import render


def load_project(path):
    path = Path(path).resolve()
    data = json.loads(path.read_text())
    if data.get('version') != 1:
        raise ValueError('Projectversie moet 1 zijn')
    data['minutes'] = positive(data['minutes'], 'minutes')
    for key in ('generate', 'mp3', 'bass_swap', 'generation_approved'):
        if key in data and not isinstance(data[key], bool):
            raise ValueError(f'{key} moet true of false zijn')
    for key in ('required', 'excluded', 'references'):
        if not isinstance(data.get(key, []), list) or any(not isinstance(x, str) for x in data.get(key, [])):
            raise ValueError(f'{key} moet een lijst met namen of paden zijn')
    if not isinstance(data['bpm_range'], list) or len(data['bpm_range']) != 2:
        raise ValueError('bpm_range vereist minimum en maximum')
    low, high = map(float, data['bpm_range'])
    if not 40 <= low <= high <= 250:
        raise ValueError('BPM-bereik moet binnen 40–250 liggen')
    for key in ('tracks', 'output'):
        value = Path(data[key]).expanduser()
        data[key] = str(value if value.is_absolute() else path.parent / value)
    refs = []
    for ref in data.get('references', []):
        value = Path(ref).expanduser()
        refs.append(value if value.is_absolute() else path.parent / value)
    data['references'] = refs
    return data


def constrained_plan(tracks, profile, seconds, low, high, required=(), excluded=(), opening=None, closing=None):
    def resolve(names):
        result = set()
        for name in names:
            matches = [t.path for t in tracks if name.casefold() in {t.title.casefold(), Path(t.path).name.casefold(), t.path.casefold()}]
            if len(matches) != 1:
                raise ValueError(f'Tracknaam ontbreekt of is dubbelzinnig: {name}')
            result.add(matches[0])
        return result
    banned = resolve(excluded)
    needed = resolve(required)
    first = next(iter(resolve([opening])), None) if opening else None
    last = next(iter(resolve([closing])), None) if closing else None
    needed |= {x for x in (first, last) if x}
    if needed & banned:
        raise ValueError('Een verplichte track is ook uitgesloten')
    pool = [t for t in tracks if t.path not in banned and low <= t.bpm <= high]
    if not needed <= {t.path for t in pool}:
        raise ValueError('Verplichte track valt buiten het BPM-bereik')
    nodes = 0
    def search(entries, remaining, end, pending):
        nonlocal nodes
        nodes += 1
        if nodes > 20000:
            raise ValueError('Zoekgrens bereikt; versmal de trackselectie of voorwaarden')
        if end >= seconds - 1e-6:
            return entries if not pending and (not last or entries[-1].track.path == last) else None
        target_energy = float(np.interp(end / seconds, np.linspace(0, 1, len(profile.energy_curve)), profile.energy_curve))
        candidates = sorted(remaining, key=lambda t: (t.path not in pending, abs(t.energy - target_energy), t.path))
        for track in candidates:
            if not entries and first and track.path != first:
                continue
            if track.path == last and pending - {last}:
                continue
            if entries and entries[-1].track.path == last:
                continue
            key_move = move(entries[-1].track.key, track.key) if entries else 'first'
            if key_move is None:
                continue
            # Gelijk tempo voorkomt pitchverschuiving in de standaardbackend.
            bpm = track.bpm
            if entries and abs(entries[-1].target_bpm - bpm) > 0.6:
                continue
            available = track.duration - track.cue
            overlap = 0 if not entries else min(profile.transition_bars * 240 / bpm, entries[-1].duration / 2, available / 2)
            overlap = math.floor(overlap / (240 / bpm)) * (240 / bpm)
            start = end - overlap
            duration = min(available, max(profile.play_seconds, overlap + 240 / bpm), seconds - start)
            if start + duration <= end + 1e-6:
                continue
            new_end = start + duration
            rest = pending - {track.path}
            if new_end >= seconds - 1e-6 and (rest or (last and track.path != last)):
                continue
            entry = Entry(track, bpm, track.cue, duration, start, overlap, key_move)
            result = search(entries + [entry], [t for t in remaining if t.path != track.path], new_end, rest)
            if result:
                return result
        return None
    entries = search([], pool, 0, needed)
    if not entries:
        raise ValueError('Geen uitvoerbare mix voor deze lengte, toonsoorten en trackvoorwaarden')
    return Plan(seconds, entries, notes=['Harde BPM- en trackvoorwaarden gecontroleerd; genre is niet automatisch herkend.'])


def prepare(data):
    if not shutil.which('ffmpeg'):
        raise ValueError('ffmpeg ontbreekt')
    tracks = scan_tracks(Path(data['tracks']))
    profile = profile_from_references(data['references']) if data['references'] else Profile(
        bpm_curve=[sum(data['bpm_range']) / 2], energy_curve=data.get('energy_curve', [5, 7, 8, 6]),
        transition_bars=data.get('transition_bars', 16), play_seconds=data.get('play_seconds', 180))
    if 'transition_bars' in data:
        profile.transition_bars = positive(data['transition_bars'], 'transition_bars')
    if 'play_seconds' in data:
        profile.play_seconds = positive(data['play_seconds'], 'play_seconds')
    from .workout import timed_plan, delivery_checks
    if 'workout_blocks' in data:
        plan = timed_plan(tracks, data['workout_blocks'], float(data['minutes']) * 60)
        names = lambda e: {e.track.title.casefold(), Path(e.track.path).name.casefold(), e.track.path.casefold()}
        selected = set().union(*(names(e) for e in plan.entries))
        if any(x.casefold() not in selected for x in data.get('required', [])) or any(x.casefold() in selected for x in data.get('excluded', [])):
            raise ValueError('Workoutplan schendt verplichte of uitgesloten tracks')
        for key, entry in [('opening', plan.entries[0]), ('closing', plan.entries[-1])]:
            if data.get(key) and data[key].casefold() not in names(entry):
                raise ValueError('Workoutplan schendt opening of slottrack')
        if any(not data['bpm_range'][0] <= e.target_bpm <= data['bpm_range'][1] for e in plan.entries):
            raise ValueError('Workoutplan schendt globaal BPM-bereik')
    else:
        plan = constrained_plan(tracks, profile, float(data['minutes']) * 60, float(data['bpm_range'][0]), float(data['bpm_range'][1]),
                                data.get('required', []), data.get('excluded', []), data.get('opening'), data.get('closing'))
    output = Path(data['output'])
    if output.suffix.lower() not in {'.wav', '.mp3'}:
        raise ValueError('Uitvoer moet WAV of MP3 zijn')
    targets = [output, output.with_suffix('.cue'), output.parent / 'setlist.json', output.parent / 'profile.json']
    if data.get('mp3') and output.suffix.lower() != '.mp3':
        targets.append(output.with_suffix('.mp3'))
    existing = [str(p) for p in targets if p.exists()]
    requests = sum(e.overlap > 0 for e in plan.entries[1:]) if data.get('generate') else 0
    report = {'name': data.get('name', ''), 'seconds': plan.duration,
              'tracks': [e.track.title for e in plan.entries], 'existing_outputs': existing,
              'generation_requests': requests, 'estimated_credits': requests * 8,
              'generation_key_present': bool(os.environ.get('STABILITY_API_KEY')),
              'notes': ['Prijsindicatie 8 credits/aanvraag; live prijs vóór betaling controleren.',
                        'Genre en sfeer zijn briefing, geen bewezen audiofilter.']}
    report.update(delivery_checks(data, plan))
    report['workout_cues'] = [{'seconds': e.start, 'track': e.track.title, 'source_cue': e.cue} for e in plan.entries] if 'workout_blocks' in data else []
    return plan, profile, report


def run_project(path, execute=False):
    data = load_project(path)
    plan, profile, report = prepare(data)
    if execute:
        if report['delivery_blockers']:
            raise ValueError('Levering niet gereed: ' + '; '.join(report['delivery_blockers']))
        if report['existing_outputs']:
            raise ValueError('Uitvoer bestaat al; kies een nieuwe uitvoermap')
        if data.get('generate'):
            budget = float(data.get('generation_credit_limit', 0))
            if not math.isfinite(budget) or budget < report['estimated_credits'] or data.get('generation_approved') is not True:
                raise ValueError('Generatie vereist expliciet akkoord en voldoende creditlimiet in de mixbrief')
            if not report['generation_key_present']:
                raise ValueError('STABILITY_API_KEY ontbreekt in procesomgeving')
        notes = render(plan, Path(data['output']), generate=data.get('generate', False), mp3=data.get('mp3', False),
                       bass_swap=data.get('bass_swap', False))
        from .models import save_json
        save_json(profile, Path(data['output']).parent / 'profile.json')
        report['render_notes'] = notes
    return report
