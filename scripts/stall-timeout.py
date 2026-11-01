#!/usr/bin/env python3
"""Run one validation step; stop it when it prints nothing for too long.

Usage: stall-timeout.py <label> <command> [args...]

A step that keeps printing is never stopped, however long it runs. The silence
limit is VALIDATION_STALL_SECONDS (default 900; 0 disables it). On a stall the
step's whole process group is stopped, the step is named on stderr and the exit
status is 124. A step that fails or is killed is named on stderr as well.
"""

import os
import selectors
import signal
import subprocess
import sys
import time

STALL_STATUS = 124


def stop(process: subprocess.Popen) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    label, command = sys.argv[1], sys.argv[2:]
    limit = int(os.environ.get("VALIDATION_STALL_SECONDS", "900"))
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    last_output = time.monotonic()
    while True:
        remaining = limit - (time.monotonic() - last_output) if limit else None
        if remaining is not None and remaining <= 0:
            stop(process)
            print(f"Validation step stalled: {label}: no output for {limit}s; stopped. "
                  "Raise VALIDATION_STALL_SECONDS if the step is legitimately silent.", file=sys.stderr)
            return STALL_STATUS
        if selector.select(timeout=remaining if remaining is None else min(remaining, 1)):
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            last_output = time.monotonic()
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    status = process.wait()
    if status != 0:
        how = f"killed by signal {-status}" if status < 0 else f"exited {status}"
        print(f"Validation step failed: {label}: {how}.", file=sys.stderr)
    return status


if __name__ == "__main__":
    sys.exit(main())
