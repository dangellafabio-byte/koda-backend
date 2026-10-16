#!/usr/bin/env python3
"""Offline behavioral regressions. Does not start the backend or call real APIs."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
commands = [
    [sys.executable, '-m', 'unittest', 'discover', '-s', 'backend/tests',
     '-p', 'test_tts_switch_regression_offline.py'],
    ['node', '--test', 'frontend/tests/voiceClientStt-lifecycle.test.cjs',
     'frontend/tests/review-blockers.test.cjs', 'frontend/tests/ttsProvider-switch.test.cjs'],
]
for command in commands:
    result = subprocess.run(command, cwd=root, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)
