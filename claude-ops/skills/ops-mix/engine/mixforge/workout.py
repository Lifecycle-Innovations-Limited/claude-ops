"""Expliciete workoutblokken en brongebaseerde leveringscontrole."""
import math
import re
from pathlib import Path
from .models import Entry, Plan


def timed_plan(tracks, blocks, seconds):
    """Ieder blok kiest expliciet één bronsegment; geen verzonnen muzikale cues."""
    entries = []
    end = 0.0
    for block in blocks:
        start = float(block['from'])
        stop = float(block['to'])
        if not all(math.isfinite(x) for x in (start, stop)) or abs(start-end) > 1e-7 or stop <= start or stop > seconds:
            raise ValueError('Workoutblokken moeten aaneengesloten de volledige mix vullen')
        matches = [t for t in tracks if block['track'].casefold() in {t.title.casefold(), Path(t.path).name.casefold(), t.path.casefold()}]
        if len(matches) != 1:
            raise ValueError('Workoutblok vereist een unieke, expliciete track')
        track = matches[0]
        low, high = map(float, block['bpm_range'])
        if not 40 <= low <= track.bpm <= high <= 250:
            raise ValueError('Workouttrack valt buiten de BPM-grenzen van het blok')
        cue = float(block.get('cue', track.cue))
        if not math.isfinite(cue) or cue < 0 or cue + stop-start > track.duration:
            raise ValueError('Workoutbronsegment is te kort of cue is ongeldig')
        entries.append(Entry(track, track.bpm, cue, stop-start, start, 0, 'workout'))
        end = stop
    if not entries or abs(end-seconds)>1e-7:
        raise ValueError('Workoutblokken vullen niet de opgegeven lengte')
    return Plan(seconds, entries, notes=['Expliciete blokgrenzen; harde cuts, geen automatische muzikale drop- of fraseherkenning.'])


def delivery_checks(data, plan):
    blockers = list(data.get('unresolved_requirements', []))
    checks = {}
    blocks = data.get('workout_blocks', [])
    metadata = data.get('track_evidence', {})
    def evidence(entry):
        # Alleen volledig pad of exacte bestandsnaam; geen title-based gok bij remixen.
        return metadata.get(entry.track.path, metadata.get(Path(entry.track.path).name, {}))
    if blocks:
        for block, entry in zip(blocks, plan.entries):
            ev = evidence(entry)
            for requirement in block.get('requirements', []):
                records = ev.get('cue_evidence', [])
                valid = any(isinstance(r, dict) and r.get('kind') == requirement
                            and isinstance(r.get('source'), str) and r['source'].strip()
                            and isinstance(r.get('cue'), (int,float)) and not isinstance(r['cue'],bool)
                            and abs(r['cue']-entry.cue)<1/plan.sample_rate
                            and r.get('reviewed') is True for r in records)
                if not valid:
                    blockers.append(f"Blok {block['from']}: bronbeoordeling ontbreekt voor {requirement}")
    apple = data.get('apple_delivery')
    if apple is not None:
        if not isinstance(apple,dict):
            raise ValueError('apple_delivery moet een object zijn')
        basis = apple.get('percentage_basis')
        if basis not in ('tracks','duration'):
            blockers.append('Apple-percentagebasis ontbreekt: tracks of duration expliciet bevestigen')
        restricted = apple.get('restricted_artists')
        if not isinstance(restricted,list) or not restricted:
            blockers.append('Apple restricted_artists ontbreekt')
            restricted=[]
        def norm(value):
            return re.sub(r'[^\w]+',' ',value.casefold()).strip()
        banned = {norm(x) for x in restricted}
        available = total = 0.0
        for entry in plan.entries:
            ev=evidence(entry)
            artists=ev.get('artists')
            if not isinstance(artists,list) or not artists or any(not isinstance(a,str) or not a.strip() for a in artists) or ev.get('artists_complete') is not True:
                blockers.append(f'Artiesten/collaborators niet volledig beoordeeld: {entry.track.title}')
            elif any(norm(a) in banned for a in artists):
                blockers.append(f'Verboden artiest: {entry.track.title}')
            weight = entry.duration-entry.overlap if basis=='duration' else 1
            total += weight
            state=ev.get('apple_available')
            source=ev.get('apple_source')
            if state is True and isinstance(source,str) and source.strip():
                available += weight
            elif state is not False or not isinstance(source,str) or not source.strip():
                blockers.append(f'Apple-beschikbaarheid niet bewezen: {entry.track.title}')
        percent=100*available/total if total else 0
        checks['apple_available_percent']=percent
        if percent < 70:
            blockers.append('Minder dan 70 procent bewezen op Apple')
        if abs(plan.duration-3600)>1/plan.sample_rate:
            blockers.append('Apple-mix moet 60 minuten duren')
        if Path(data['output']).suffix.lower()!='.wav':
            blockers.append('Apple vereist WAV')
        if data.get('generate'):
            blockers.append('Apple-beschikbaarheid van gegenereerde muziek is niet bewezen')
    checks['delivery_blockers']=blockers
    checks['ready_for_delivery']=not blockers
    return checks
