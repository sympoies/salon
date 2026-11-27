"""The validation stall watchdog stops a silent step and spares a printing one."""

import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

WATCHDOG = Path(__file__).resolve().parents[1] / "stall-timeout.py"


def run(limit, label, *command):
    return subprocess.run(
        [sys.executable, str(WATCHDOG), label, *command],
        env=dict(os.environ, VALIDATION_STALL_SECONDS=str(limit)),
        capture_output=True, text=True, timeout=30,
    )


class StallTimeoutTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "macOS exited-group behavior")
    def test_exited_group_with_open_output_stalls_without_traceback(self):
        command = 'import subprocess; subprocess.Popen(["sleep", "3"], start_new_session=True)'
        result = run(1, "exited step", sys.executable, "-c", command)
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn("exited step", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_macos_exited_group_during_signal_cleanup(self):
        spec = importlib.util.spec_from_file_location("stall_timeout", WATCHDOG)
        watchdog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watchdog)
        for failing_signal in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(failing_signal=failing_signal):
                process = mock.Mock(pid=123)
                def killpg(_pgid, sig):
                    if sig == failing_signal:
                        raise PermissionError(1, "Operation not permitted")
                with mock.patch.object(watchdog.sys, "platform", "darwin"), \
                     mock.patch.object(watchdog.os, "killpg", side_effect=killpg), \
                     mock.patch.object(watchdog.time, "monotonic", side_effect=[0, 6, 6]):
                    watchdog.stop(process)
                process.wait.assert_called_once()

    def test_non_macos_signal_permission_error_is_preserved(self):
        spec = importlib.util.spec_from_file_location("stall_timeout", WATCHDOG)
        watchdog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watchdog)
        with mock.patch.object(watchdog.sys, "platform", "linux"), \
             mock.patch.object(watchdog.os, "killpg", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                watchdog.stop(mock.Mock(pid=123))

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
