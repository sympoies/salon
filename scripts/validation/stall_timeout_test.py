"""The validation stall watchdog stops a silent step and spares a printing one."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

WATCHDOG = Path(__file__).resolve().parents[1] / "stall-timeout.py"


def run(limit, label, *command):
    return subprocess.run(
        [sys.executable, str(WATCHDOG), label, *command],
        env=dict(os.environ, VALIDATION_STALL_SECONDS=str(limit)),
        capture_output=True, text=True, timeout=30,
    )


class StallTimeoutTest(unittest.TestCase):
    def test_silent_step_fails_by_name_and_leaves_no_child(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "pid"
            script = f'sleep 60 & echo $! > {pid_file}; wait'
            started = time.monotonic()
            result = run(1, "unit step", "bash", "-c", script)
            self.assertNotEqual(result.returncode, 0)
            self.assertLess(time.monotonic() - started, 20)
            self.assertIn("unit step", result.stderr)
            self.assertIn("no output for 1s", result.stderr)
            child = int(pid_file.read_text())
            time.sleep(0.5)
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)

    def test_step_that_keeps_printing_past_the_limit_passes(self):
        result = run(1, "chatty step", "bash", "-c", "for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.3; done")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tick 8", result.stdout)

    def test_exit_status_of_the_step_is_kept(self):
        self.assertEqual(run(5, "failing step", "bash", "-c", "exit 7").returncode, 7)


if __name__ == "__main__":
    unittest.main()
