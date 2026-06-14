#!/usr/bin/env bash
# Mock once.sh — always permit (return 0) so tests can run multiple times
# without rate-limit throttling from the real once.sh guard.
#
# Usage: source this instead of $HOME/.claude/scripts/lib/once.sh
#
claude_once() {
  # Accept key + optional throttle but ignore them; always return success
  return 0
}
