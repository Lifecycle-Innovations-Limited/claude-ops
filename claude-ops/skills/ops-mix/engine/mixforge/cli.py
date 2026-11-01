"""Offline commandoregelinterface."""

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
import tempfile
from .analyze import analyze
from .models import Plan, Profile, positive, read_json, save_json
from .reference import profile_from_references
from .render import render
from .setlist import plan_tracks, scan_tracks
from .stability import DEFAULT_ENDPOINT


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mixforge", description="Maak een mixtape uit eigen tracks en referenties. Standaard volledig offline.")
    sub = parser.add_subparsers(dest="command", required=True)
    analysis = sub.add_parser("analyze", help="Schat BPM, Camelot-key, energie en beatgrid")
    analysis.add_argument("audio", type=Path)
    analysis.add_argument("-o", "--output", type=Path)
    profile = sub.add_parser("profile", help="Leer een stijlprofiel uit audio en/of exports")
    profile.add_argument("references", nargs="*", type=Path)
    profile.add_argument("--mik", type=Path, help="CSV/JSON-setlist met BPM/key/energy")
    profile.add_argument("-o", "--output", type=Path, required=True)
    plan = sub.add_parser("plan", help="Plan harmonisch passende tracks voor de opgegeven lengte")
    plan.add_argument("--tracks", type=Path, required=True)
    plan.add_argument("--profile", type=Path, required=True)
    plan.add_argument("--minutes", type=float, required=True)
    plan.add_argument("--mik", type=Path, help="Metadata voor tracks, gematcht op titel/bestandsnaam")
    plan.add_argument("--backend", choices=["numpy", "librosa", "rubberband"], default="numpy")
    plan.add_argument("-o", "--output", type=Path, required=True)
    rendering = sub.add_parser("render", help="Render WAV/MP3 met setlist en cue-sheet")
    rendering.add_argument("--setlist", type=Path, required=True)
    rendering.add_argument("-o", "--output", type=Path, required=True)
    make = sub.add_parser("make", help="Voer profile, plan en render samen uit")
    make.add_argument("references", nargs="*", type=Path)
    make.add_argument("--mik", type=Path)
    make.add_argument("--track-metadata", type=Path)
    make.add_argument("--tracks", type=Path, required=True)
    make.add_argument("--minutes", type=float, required=True)
    make.add_argument("-o", "--output", type=Path, required=True, help="Uitvoerbestand .wav of .mp3")
    for command in (rendering, make):
        group = command.add_mutually_exclusive_group()
        group.add_argument("--generate", action="store_true", help="Vraag betaalde Stable Audio-tussenstukken aan")
        group.add_argument("--no-generate", dest="generate", action="store_false", help="Werk offline (standaard)")
        command.set_defaults(generate=False)
        command.add_argument("--mp3", action="store_true", help="Schrijf naast WAV ook MP3")
        command.add_argument("--bass-swap", action="store_true")
        command.add_argument("--backend", choices=["numpy", "librosa", "rubberband"], default="numpy")
        command.add_argument("--stability-endpoint", default=DEFAULT_ENDPOINT)
        command.add_argument("--stability-model", default=None)
        command.add_argument("--stability-max-seconds", type=float, default=190)
    project = sub.add_parser('project', help='Hervat een mixbrief en controleer vóór rendering')
    project.add_argument('brief', type=Path)
    project.add_argument('--render', action='store_true', help='Render na controle; bestaande uitvoer wordt geweigerd')
    judge = sub.add_parser('judge', help='Meet volledige mix en alle opgegeven transities, standaard offline')
    judge.add_argument('audio', type=Path)
    judge.add_argument('--brief', type=Path)
    judge.add_argument('--setlist', type=Path)
    judge.add_argument('-o', '--output', type=Path, required=True, help='Nieuwe audiopakketmap')
    judge.add_argument('--silence-db', type=float, default=-60)
    judge.add_argument('--silence-seconds', type=float, default=1)
    judge.add_argument('--clip-level', type=float, default=.999)
    judge.add_argument('--level-jump-db', type=float, default=6)
    judge.add_argument('--window-seconds', type=float, default=1)
    judge.add_argument('--transition-context-seconds', type=float, default=10)
    judge.add_argument('--audio-judge', choices=['google'])
    judge.add_argument('--audio-model', help='Expliciet gekozen runtime-model, geen standaardmodel')
    judge.add_argument('--approve-audio-upload', action='store_true',
                       help='Alleen na toestemming voor deze audio, provider en kosten')
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == 'judge':
            from .judge import judge_mix
            report = judge_mix(args.audio, brief=args.brief, setlist=args.setlist, output=args.output,
                               silence_db=args.silence_db, silence_seconds=args.silence_seconds,
                               clip_level=args.clip_level, level_jump_db=args.level_jump_db,
                               window_seconds=args.window_seconds,
                               transition_context_seconds=args.transition_context_seconds)
            if args.audio_judge:
                from .judge_audio import judge_audio
                report['musical'] = judge_audio(report, approved=args.approve_audio_upload,
                                               model=args.audio_model)
                # Local evidence remains stable; publish opinions separately and
                # exclusively so neither report can overwrite a concurrent writer.
                report_path = args.output / 'musical-report.json'
                with tempfile.NamedTemporaryFile(mode='w', dir=args.output, prefix='.report-',
                                                 suffix='.json', delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    try:
                        json.dump(report, temporary, indent=2, ensure_ascii=False, allow_nan=False)
                        temporary.write('\n')
                    except BaseException:
                        temporary_path.unlink(missing_ok=True)
                        raise
                try:
                    os.link(temporary_path, report_path)
                finally:
                    temporary_path.unlink(missing_ok=True)
            print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
            return 0
        if args.command == 'project':
            from .project import run_project
            print(json.dumps(run_project(args.brief, args.render), indent=2, ensure_ascii=False))
            return 0
        if args.command == "analyze":
            track = analyze(args.audio)
            if args.output:
                save_json(track, args.output)
            else:
                print(json.dumps(asdict(track), indent=2, ensure_ascii=False))
            return 0
        if args.command == "profile":
            save_json(profile_from_references(args.references, args.mik), args.output)
        elif args.command == "plan":
            profile = Profile(**read_json(args.profile))
            plan = plan_tracks(scan_tracks(args.tracks, args.mik), profile,
                               positive(args.minutes, "minutes") * 60, args.backend)
            save_json(plan, args.output)
        else:
            if args.command == "make":
                profile = profile_from_references(args.references, args.mik)
                plan = plan_tracks(scan_tracks(args.tracks, args.track_metadata), profile,
                                   positive(args.minutes, "minutes") * 60, args.backend)
                save_json(profile, args.output.parent / "profile.json")
            else:
                plan = Plan(**read_json(args.setlist))
            for note in render(plan, args.output, generate=args.generate, mp3=args.mp3,
                               backend=args.backend, bass_swap=args.bass_swap,
                               endpoint=args.stability_endpoint, model=args.stability_model,
                               max_seconds=positive(args.stability_max_seconds, "max_seconds")):
                print(note, file=sys.stderr)
        print(f"Geschreven: {args.output}")
        return 0
    except (ValueError, TypeError, KeyError, OSError) as error:
        print(f"mixforge: {error}", file=sys.stderr)
        return 2
