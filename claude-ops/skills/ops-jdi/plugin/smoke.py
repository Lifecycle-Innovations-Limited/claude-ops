#!/usr/bin/env python3
"""Opt-in paid protected-runtime smoke; never runs on import. Requires an explicit budget argument.

Flow exercised: declare contract -> premature stop -> continuation -> harmless echo -> typed evidence
-> delivery record -> delivered answer with semantic review pending. Scratch directory only; no config, security or real project.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-paid-smoke', action='store_true')
    parser.add_argument('--max-budget-usd', type=float, required=True,
                        help='Required spending cap for the single claude session (for example 0.50).')
    args = parser.parse_args()
    if not args.run_paid_smoke:
        parser.error('Explicit --run-paid-smoke required; this can cost up to --max-budget-usd.')
    if not 0 < args.max_budget_usd <= 2.0:
        parser.error('--max-budget-usd must be in (0, 2.0].')
    root = Path(__file__).resolve().parent
    sid = str(uuid.uuid4())
    bridge = root / 'hooks/bridge.py'
    with tempfile.TemporaryDirectory(prefix='jdi-harmless-') as tmp:
        prompt = (
            'Harmless Just Do It integration test in a scratch directory. Do not edit any configuration, security, credentials or real project. '
            f'Use only the scratch directory {tmp}. Use only Bash, no other tools. Never include a revision field in any stdin JSON: every tool call bumps the revision, so it is always stale. '
            f'Step 1: run `python3 -I {bridge} status --session {sid}` and read the generation. '
            f'Step 2: run `python3 -I {bridge} contract --session {sid}` with stdin '
            '{"generation":<generation>,"issue":"TEAM-1",'
            '"outcomes":[{"id":"smoke","owner":"session","dod":"print JDI_SECOND_PASS and deliver it"}]}. '
            'Then reply with exactly: JDI_FIRST_PASS and do nothing else this turn (a deliberately premature stop). '
            'Step 3, only after the native Stop hook continues you: run one harmless Bash command `echo JDI_SECOND_PASS`. '
            f'Step 4: run `python3 -I {bridge} status --session {sid}` and read the receipt id, tool and outputHash of that echo. '
            f'Step 5: run `python3 -I {bridge} evidence --session {sid}` with stdin '
            '{"generation":<generation>,"collection":"outcomes","id":"smoke",'
            '"receipt":"<receipt id>","pointer":{"type":"transcript","tool":"Bash",'
            '"tool_use_id":"<receipt id>","outputHash":"<outputHash>"},'
            '"inspection":"the echoed output shows JDI_SECOND_PASS"}. '
            f'Step 6: run `python3 -I {bridge} deliver --session {sid}` with stdin '
            '{"generation":<generation>,"text":"JDI_SECOND_PASS","outcomes":["smoke"]}. '
            'Step 7: reply with exactly: JDI_SECOND_PASS (the same bytes recorded in step 6, nothing before or after). '
            'If the Stop hook asks you to record delivery or reports a delivery mismatch, follow its instruction once. '
            'Do not run /just-do-it audit, alter the bridge, pause it, or claim any broader acceptance.')
        command = ['claude', '--plugin-dir', str(root), '--session-id', sid,
                   '--max-budget-usd', str(args.max_budget_usd), '--output-format', 'json',
                   '--disable-slash-commands', '-p', prompt]
        result = subprocess.run(command, cwd=tmp, capture_output=True, text=True, timeout=1200)
        state_path = root / 'runtime' / (sid + '.json')
        summary = {}
        try:
            state = json.loads(state_path.read_text())
            summary = {k: state.get(k) for k in ('phase', 'next', 'generation', 'stopInvocations', 'continuations', 'stalled')}
            summary['deliveries'] = state.get('deliveries')
            summary['audit'] = state.get('audit')
            summary['outcomes'] = {k: len(v.get('evidence', [])) for k, v in state.get('outcomes', {}).items()}
        except (OSError, ValueError):
            summary = {'state': 'unreadable'}
        print(json.dumps(dict(session_id=sid, budget=args.max_budget_usd, exit_code=result.returncode,
                              stdout=result.stdout, stderr=result.stderr,
                              state_path=str(state_path), state_summary=summary)))
        return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
