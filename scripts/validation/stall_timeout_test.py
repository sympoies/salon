"""The validation stall watchdog stops a silent step and spares a printing one."""

import os
from pathlib import Path
import signal
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
        result = run(5, "failing step", "bash", "-c", "exit 7")
        self.assertEqual(result.returncode, 7)
        self.assertIn("failing step", result.stderr)

    def test_step_killed_by_a_signal_is_reported_by_name(self):
        result = run(5, "killed step", "bash", "-c", "kill -9 $$")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("killed step", result.stderr)
        self.assertIn("signal 9", result.stderr)

    def test_step_that_closes_its_output_but_keeps_running_is_still_stopped(self):
        started = time.monotonic()
        result = run(1, "closed output step", "bash", "-c", "exec >&- 2>&-; sleep 60")
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(time.monotonic() - started, 20)
        self.assertIn("closed output step", result.stderr)

    def test_term_resistant_child_in_the_group_is_killed_when_a_stall_stops_the_step(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "pid"
            script = f"(trap '' TERM; exec sleep 60) & echo $! > {pid_file}; wait"
            result = run(1, "resistant step", "bash", "-c", script)
            self.assertEqual(result.returncode, 124)
            child = int(pid_file.read_text())
            time.sleep(0.5)
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)

    def test_cancelling_the_watchdog_stops_the_step_and_exits_conventionally(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "pid"
            watchdog = subprocess.Popen(
                [sys.executable, str(WATCHDOG), "cancelled step", "bash", "-c", f"sleep 60 & echo $! > {pid_file}; wait"],
                env=dict(os.environ, VALIDATION_STALL_SECONDS="30"), stderr=subprocess.PIPE)
            for _ in range(100):
                if pid_file.exists() and pid_file.read_text().strip():
                    break
                time.sleep(0.1)
            child = int(pid_file.read_text())
            watchdog.send_signal(signal.SIGTERM)
            self.assertEqual(watchdog.wait(timeout=20), 128 + signal.SIGTERM)
            time.sleep(0.5)
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)
            watchdog.stderr.close()


if __name__ == "__main__":
    unittest.main()
