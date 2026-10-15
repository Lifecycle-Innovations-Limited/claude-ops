#!/usr/bin/env python3
"""Check skill loading without executing a machine-wide diagnostic scan."""

from pathlib import Path
import re
import unittest


SKILL = Path(__file__).resolve().parents[1] / "skills/ops-speedup/SKILL.md"


def invocation_defects(text):
    defects = []
    if re.search(r"^```!", text, re.MULTILINE):
        defects.append("automatic preamble")
    phases = text.split("## Phase 1", 1)[1].split("## Phase 3", 1)[0]
    commands = re.findall(r"^\$\{CLAUDE_PLUGIN_ROOT\}/bin/ops-speedup[^\n]*", phases, re.MULTILINE)
    if commands != ["${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --scan"]:
        defects.append("multiple or masked diagnostic commands")
    for rule in (
        "Reuse an in-flight",
        "never launch another scan",
        "Do not create a second recurring job",
        "Preserve stderr and the real exit status",
        "wait for\nthe completion notification",
    ):
        if rule not in phases:
            defects.append("missing lifecycle rule: " + rule)
    return defects


class SpeedupSkillInvocationTests(unittest.TestCase):
    def test_loading_does_not_execute_scan(self):
        self.assertEqual(invocation_defects(SKILL.read_text()), [])

    def test_automatic_preamble_mutation_is_rejected(self):
        text = SKILL.read_text().replace("```bash", "```!", 1)
        self.assertIn("automatic preamble", invocation_defects(text))

    def test_header_command_mutation_is_rejected(self):
        text = SKILL.read_text().replace(
            "${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --scan",
            "${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup\n${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --scan",
            1,
        )
        self.assertIn("multiple or masked diagnostic commands", invocation_defects(text))

    def test_failure_mask_mutation_is_rejected(self):
        text = SKILL.read_text().replace(
            "${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --scan",
            "${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --scan 2>/dev/null || echo '{}'",
            1,
        )
        self.assertIn("multiple or masked diagnostic commands", invocation_defects(text))

    def test_pending_run_rule_mutation_is_rejected(self):
        text = SKILL.read_text().replace("never launch another scan", "launch another scan", 1)
        self.assertTrue(invocation_defects(text))


if __name__ == "__main__":
    unittest.main()
