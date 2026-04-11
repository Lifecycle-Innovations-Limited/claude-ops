# Phase 6: YOLO Mode — Context

## Scope
Verify ops-yolo spawns 4 agents in parallel and agents exist.

## Agents
- agents/yolo-ceo.md — Strategic, opus model, max 20 turns
- agents/yolo-cto.md — Technical, sonnet model, max 25 turns
- agents/yolo-cfo.md — Financial, sonnet model, max 20 turns
- agents/yolo-coo.md — Operations, sonnet model, max 25 turns

## Orchestration
- Phase 1: pre-gather ALL data via ! injection (8 parallel shell injections)
- Phase 2: spawn 4 agents simultaneously, each writes to /tmp/yolo-[session]/
- Phase 3: synthesize Hard Truths report
- Phase 4: YOLO autonomous mode (if user types YOLO all-caps)
